#include "pk_http.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "lwip/altcp.h"
#include "lwip/altcp_tcp.h"
#include "lwip/altcp_tls.h"
#include "lwip/dns.h"
#include "lwip/pbuf.h"
#include "mbedtls/ssl.h"
#include "pico/cyw43_arch.h"
#include "pico/stdlib.h"

#include "certs/pk_ca_roots.h"
#include "pk_platform.h"
#include "pk_time.h"

typedef struct {
    const pk_http_request_t *request;
    struct altcp_pcb *pcb;
    ip_addr_t addr;
    bool tls;
    bool dns_done;
    bool finished;
    bool failed;
    bool complete;
    pk_http_response_t response;
    char host[128];
    char path[256];
    uint16_t port;
} pk_http_state_t;

// One request at a time: the firmware is a single poll loop, and the state
// (the header block alone is 1.5 KB) has no business on the 16 KB stack.
static pk_http_state_t s_state;
static bool s_busy = false;
// lwIP cannot cancel a DNS query: a request that timed out waiting for one
// must not have its late answer land on the next request's state.
static uintptr_t s_generation = 0;

// mbedTLS sends at most MBEDTLS_SSL_OUT_CONTENT_LEN (2048) per record and
// altcp_tls asserts (= panics) when a write does not fit in one, so a request
// body goes down in pieces well under that.
#define PK_HTTP_BODY_PIECE 1024u

// One TLS client config for the process: verifies against the embedded CA
// roots (certs/pk_ca_roots.h). sizeof includes the trailing NUL, which
// mbedTLS's PEM parser requires.
static struct altcp_tls_config *tls_config(void)
{
    static struct altcp_tls_config *s_config = NULL;
    if (s_config == NULL) {
        s_config = altcp_tls_create_config_client(
            (const u8_t *)PK_CA_ROOTS_PEM, sizeof(PK_CA_ROOTS_PEM));
    }
    return s_config;
}

static void state_fail(pk_http_state_t *state)
{
    state->failed = true;
    state->finished = true;
}

static bool parse_url(pk_http_state_t *state, const char *url)
{
    const char *rest = NULL;
    if (strncmp(url, "http://", 7) == 0) {
        rest = url + 7;
        state->tls = false;
        state->port = 80;
    } else if (strncmp(url, "https://", 8) == 0) {
        rest = url + 8;
        state->tls = true;
        state->port = 443;
    } else {
        return false;
    }
    const char *slash = strchr(rest, '/');
    const char *host_end = slash ? slash : rest + strlen(rest);
    const char *colon = memchr(rest, ':', (size_t)(host_end - rest));
    const char *name_end = host_end;
    if (colon) {
        state->port = (uint16_t)atoi(colon + 1);
        name_end = colon;
    }
    size_t name_len = (size_t)(name_end - rest);
    if (name_len == 0 || name_len >= sizeof(state->host)) return false;
    memcpy(state->host, rest, name_len);
    state->host[name_len] = '\0';
    if (slash && strlen(slash) >= sizeof(state->path)) return false;
    snprintf(state->path, sizeof(state->path), "%s", slash ? slash : "/");
    return true;
}

static err_t on_recv(void *arg, struct altcp_pcb *pcb, struct pbuf *p, err_t err)
{
    pk_http_state_t *state = arg;
    if (p == NULL) { // remote closed
        state->complete = pk_http_response_eof(&state->response);
        state->finished = true;
        return ERR_OK;
    }
    if (err != ERR_OK) {
        pbuf_free(p);
        state_fail(state);
        return err;
    }
    for (struct pbuf *q = p; q != NULL && !state->finished; q = q->next) {
        switch (pk_http_response_feed(&state->response, q->payload, q->len)) {
            case PK_HTTP_READING:
                break;
            case PK_HTTP_DONE:
                // Whole response in hand: no need to wait for the peer (a
                // keep-alive proxy never closes).
                state->complete = true;
                state->finished = true;
                break;
            default:
                state_fail(state);
                break;
        }
    }
    altcp_recved(pcb, p->tot_len);
    pbuf_free(p);
    return ERR_OK;
}

static void on_err(void *arg, err_t err)
{
    (void)err;
    pk_http_state_t *state = arg;
    state->pcb = NULL; // lwIP already freed it
    if (!state->finished) {
        state_fail(state);
    }
}

static err_t on_connected(void *arg, struct altcp_pcb *pcb, err_t err)
{
    pk_http_state_t *state = arg;
    const pk_http_request_t *request = state->request;
    if (err != ERR_OK) {
        state_fail(state);
        return err;
    }
    static char head[1024];
    size_t len = (size_t)snprintf(head, sizeof(head),
                                  "%s %s HTTP/1.1\r\nHost: %s\r\nConnection: close\r\n"
                                  "User-Agent: frameos-pico/" FRAMEOS_VERSION "\r\n",
                                  request->method ? request->method : "GET", state->path, state->host);
    if (len < sizeof(head) && request->bearer_token && request->bearer_token[0]) {
        len += (size_t)snprintf(head + len, sizeof(head) - len, "Authorization: Bearer %s\r\n",
                                request->bearer_token);
    }
    if (len < sizeof(head) && request->if_none_match && request->if_none_match[0]) {
        len += (size_t)snprintf(head + len, sizeof(head) - len, "If-None-Match: %s\r\n",
                                request->if_none_match);
    }
    if (len < sizeof(head) && request->body != NULL) {
        len += (size_t)snprintf(head + len, sizeof(head) - len,
                                "Content-Type: %s\r\nContent-Length: %u\r\n",
                                request->content_type ? request->content_type : "application/json",
                                (unsigned)request->body_len);
    }
    if (len < sizeof(head)) len += (size_t)snprintf(head + len, sizeof(head) - len, "\r\n");

    size_t body_len = request->body ? request->body_len : 0;
    // Per-record TLS overhead is a few dozen bytes; leave room for it.
    size_t pieces = (body_len + PK_HTTP_BODY_PIECE - 1) / PK_HTTP_BODY_PIECE;
    bool ok = len < sizeof(head) && len + body_len + (pieces + 1) * 64u <= altcp_sndbuf(pcb) &&
              altcp_write(pcb, head, (u16_t)len, TCP_WRITE_FLAG_COPY) == ERR_OK;
    for (size_t offset = 0; ok && offset < body_len; offset += PK_HTTP_BODY_PIECE) {
        size_t piece = body_len - offset < PK_HTTP_BODY_PIECE ? body_len - offset : PK_HTTP_BODY_PIECE;
        ok = altcp_write(pcb, request->body + offset, (u16_t)piece, TCP_WRITE_FLAG_COPY) == ERR_OK;
    }
    if (!ok) {
        // Not ERR_ABRT: the pcb is still ours, pk_http_request() closes it.
        state_fail(state);
        return ERR_OK;
    }
    altcp_output(pcb);
    return ERR_OK;
}

static void on_dns(const char *name, const ip_addr_t *addr, void *arg)
{
    (void)name;
    if ((uintptr_t)arg != s_generation) return; // an answer for a request long gone
    pk_http_state_t *state = &s_state;
    if (addr == NULL) {
        state_fail(state);
        return;
    }
    state->addr = *addr;
    state->dns_done = true;
}

static bool past(absolute_time_t deadline)
{
    return absolute_time_diff_us(get_absolute_time(), deadline) < 0;
}

pk_http_result_t pk_http_request(const pk_http_request_t *request)
{
    pk_http_result_t result = {.status = -1, .retry_after = -1};
    if (s_busy) {
        result.status = -2;
        return result;
    }
    pk_http_state_t *state = &s_state;
    memset(state, 0, sizeof(*state));
    state->request = request;
    pk_http_response_init(&state->response, request->sink, request->sink_arg);
    if (!parse_url(state, request->url)) {
        return result;
    }
    s_busy = true;
    s_generation++;

    absolute_time_t deadline = make_timeout_time_ms(
        request->timeout_ms > 0 ? request->timeout_ms : 60000);

    if (state->tls) {
        // Certificate validity checks want real time; give SNTP a moment.
        pk_time_start_sntp();
        absolute_time_t sntp_deadline = make_timeout_time_ms(8000);
        while (!pk_time_synced() && !past(sntp_deadline)) {
            pk_wait_ms(10);
        }
        if (!pk_time_synced()) {
            printf("http: no NTP time yet, validating certificates against a build-time floor\n");
        }
    }

    cyw43_arch_lwip_begin();
    err_t err = dns_gethostbyname(state->host, &state->addr, on_dns, (void *)s_generation);
    cyw43_arch_lwip_end();
    if (err == ERR_OK) {
        state->dns_done = true;
    } else if (err != ERR_INPROGRESS) {
        state_fail(state);
    }

    while (!state->dns_done && !state->failed) {
        if (past(deadline)) {
            state_fail(state);
            break;
        }
        pk_wait_ms(1);
    }

    if (!state->failed) {
        cyw43_arch_lwip_begin();
        if (state->tls) {
            struct altcp_tls_config *config = tls_config();
            state->pcb = config ? altcp_tls_new(config, IP_GET_TYPE(&state->addr)) : NULL;
            if (state->pcb != NULL) {
                // SNI + hostname verification against the certificate.
                mbedtls_ssl_set_hostname(
                    (mbedtls_ssl_context *)altcp_tls_context(state->pcb), state->host);
            }
        } else {
            state->pcb = altcp_tcp_new_ip_type(IP_GET_TYPE(&state->addr));
        }
        if (state->pcb == NULL) {
            state_fail(state);
        } else {
            altcp_arg(state->pcb, state);
            altcp_recv(state->pcb, on_recv);
            altcp_err(state->pcb, on_err);
            if (altcp_connect(state->pcb, &state->addr, state->port, on_connected) != ERR_OK) {
                state_fail(state);
            }
        }
        cyw43_arch_lwip_end();
    }

    while (!state->finished) {
        if (past(deadline)) {
            state_fail(state);
            break;
        }
        pk_wait_ms(1);
    }

    cyw43_arch_lwip_begin();
    if (state->pcb != NULL) {
        altcp_arg(state->pcb, NULL);
        altcp_recv(state->pcb, NULL);
        altcp_err(state->pcb, NULL);
        if (altcp_close(state->pcb) != ERR_OK) {
            altcp_abort(state->pcb);
        }
        state->pcb = NULL;
    }
    cyw43_arch_lwip_end();

    const pk_http_response_t *response = &state->response;
    result.status = response->status != 0 ? response->status : -1;
    result.body_bytes = response->body_bytes;
    result.complete = state->complete && !state->failed;
    result.sink_aborted = response->progress == PK_HTTP_SINK_ABORTED;
    result.retry_after = response->retry_after;
    snprintf(result.etag, sizeof(result.etag), "%s", response->etag);
    s_busy = false;
    return result;
}

bool pk_http_buffer_sink(void *arg, const uint8_t *data, size_t len)
{
    pk_http_buffer_t *buffer = arg;
    if (buffer->len + len + 1 > buffer->cap) return false;
    memcpy(buffer->data + buffer->len, data, len);
    buffer->len += len;
    buffer->data[buffer->len] = '\0';
    return true;
}

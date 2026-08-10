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
#include "pk_time.h"

#define PK_HTTP_HEADER_MAX 1024

typedef struct {
    const pk_http_request_t *request;
    struct altcp_pcb *pcb;
    ip_addr_t addr;
    bool tls;
    bool dns_done;
    bool connected;
    bool finished;
    bool failed;
    bool headers_done;
    bool sink_aborted;
    int status;
    // Status line + headers accumulate here until the blank line; the body
    // never touches this buffer.
    char header[PK_HTTP_HEADER_MAX];
    size_t header_len;
    size_t body_bytes;
    char host[128];
    char path[256];
    uint16_t port;
} pk_http_state_t;

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
    snprintf(state->path, sizeof(state->path), "%s", slash ? slash : "/");
    return true;
}

bool pk_http_url_is_supported(const char *url)
{
    return url != NULL &&
           (strncmp(url, "http://", 7) == 0 || strncmp(url, "https://", 8) == 0);
}

static err_t on_recv(void *arg, struct altcp_pcb *pcb, struct pbuf *p, err_t err)
{
    pk_http_state_t *state = arg;
    if (p == NULL) { // remote closed: end of body
        state->finished = true;
        return ERR_OK;
    }
    if (err != ERR_OK) {
        pbuf_free(p);
        state_fail(state);
        return err;
    }
    for (struct pbuf *q = p; q != NULL; q = q->next) {
        const uint8_t *data = q->payload;
        size_t len = q->len;
        if (!state->headers_done) {
            size_t take = len;
            size_t room = sizeof(state->header) - 1 - state->header_len;
            if (take > room) take = room;
            memcpy(state->header + state->header_len, data, take);
            state->header_len += take;
            state->header[state->header_len] = '\0';
            char *body = strstr(state->header, "\r\n\r\n");
            if (body == NULL) {
                if (room == 0) { // oversized headers
                    state_fail(state);
                    break;
                }
                continue;
            }
            state->headers_done = true;
            if (sscanf(state->header, "HTTP/%*d.%*d %d", &state->status) != 1) {
                state_fail(state);
                break;
            }
            size_t header_total = (size_t)(body + 4 - state->header);
            const uint8_t *body_start = (const uint8_t *)state->header + header_total;
            size_t body_in_header = state->header_len - header_total;
            if (body_in_header > 0 && state->status == 200) {
                if (!state->request->sink(state->request->sink_arg, body_start, body_in_header)) {
                    state->sink_aborted = true;
                    state_fail(state);
                    break;
                }
                state->body_bytes += body_in_header;
            }
            if (take < len && state->status == 200) {
                if (!state->request->sink(state->request->sink_arg, data + take, len - take)) {
                    state->sink_aborted = true;
                    state_fail(state);
                    break;
                }
                state->body_bytes += len - take;
            }
            continue;
        }
        if (state->status == 200) {
            if (!state->request->sink(state->request->sink_arg, data, len)) {
                state->sink_aborted = true;
                state_fail(state);
                break;
            }
        }
        state->body_bytes += len;
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
    if (err != ERR_OK) {
        state_fail(state);
        return err;
    }
    state->connected = true;
    char request[640];
    int len;
    if (state->request->bearer_token && state->request->bearer_token[0]) {
        len = snprintf(request, sizeof(request),
                       "GET %s HTTP/1.1\r\nHost: %s\r\nAuthorization: Bearer %s\r\n"
                       "Connection: close\r\nUser-Agent: frameos-pico/" FRAMEOS_VERSION "\r\n\r\n",
                       state->path, state->host, state->request->bearer_token);
    } else {
        len = snprintf(request, sizeof(request),
                       "GET %s HTTP/1.1\r\nHost: %s\r\n"
                       "Connection: close\r\nUser-Agent: frameos-pico/" FRAMEOS_VERSION "\r\n\r\n",
                       state->path, state->host);
    }
    if (len <= 0 || (size_t)len >= sizeof(request) ||
        altcp_write(pcb, request, (u16_t)len, TCP_WRITE_FLAG_COPY) != ERR_OK) {
        state_fail(state);
        return ERR_ABRT;
    }
    altcp_output(pcb);
    return ERR_OK;
}

static void on_dns(const char *name, const ip_addr_t *addr, void *arg)
{
    (void)name;
    pk_http_state_t *state = arg;
    if (addr == NULL) {
        state_fail(state);
        return;
    }
    state->addr = *addr;
    state->dns_done = true;
}

pk_http_result_t pk_http_get(const pk_http_request_t *request)
{
    pk_http_result_t result = {.status = -1, .body_bytes = 0, .sink_aborted = false};
    pk_http_state_t state;
    memset(&state, 0, sizeof(state));
    state.request = request;
    if (!parse_url(&state, request->url)) {
        return result;
    }

    absolute_time_t deadline = make_timeout_time_ms(
        request->timeout_ms > 0 ? request->timeout_ms : 60000);

    if (state.tls) {
        // Certificate validity checks want real time; give SNTP a moment.
        pk_time_start_sntp();
        absolute_time_t sntp_deadline = make_timeout_time_ms(8000);
        while (!pk_time_synced() &&
               absolute_time_diff_us(get_absolute_time(), sntp_deadline) > 0) {
            cyw43_arch_poll();
            sleep_ms(10);
        }
        if (!pk_time_synced()) {
            printf("http: no NTP time yet, validating certificates against a "
                   "build-time floor\n");
        }
    }

    cyw43_arch_lwip_begin();
    err_t err = dns_gethostbyname(state.host, &state.addr, on_dns, &state);
    if (err == ERR_OK) {
        state.dns_done = true;
    } else if (err != ERR_INPROGRESS) {
        cyw43_arch_lwip_end();
        return result;
    }
    cyw43_arch_lwip_end();

    while (!state.dns_done && !state.failed) {
        if (absolute_time_diff_us(get_absolute_time(), deadline) < 0) {
            state_fail(&state);
            break;
        }
        cyw43_arch_poll();
        sleep_ms(1);
    }

    if (!state.failed) {
        cyw43_arch_lwip_begin();
        if (state.tls) {
            struct altcp_tls_config *config = tls_config();
            state.pcb = config ? altcp_tls_new(config, IP_GET_TYPE(&state.addr)) : NULL;
            if (state.pcb != NULL) {
                // SNI + hostname verification against the certificate.
                mbedtls_ssl_set_hostname(
                    (mbedtls_ssl_context *)altcp_tls_context(state.pcb), state.host);
            }
        } else {
            state.pcb = altcp_tcp_new_ip_type(IP_GET_TYPE(&state.addr));
        }
        if (state.pcb == NULL) {
            state_fail(&state);
        } else {
            altcp_arg(state.pcb, &state);
            altcp_recv(state.pcb, on_recv);
            altcp_err(state.pcb, on_err);
            if (altcp_connect(state.pcb, &state.addr, state.port, on_connected) != ERR_OK) {
                state_fail(&state);
            }
        }
        cyw43_arch_lwip_end();
    }

    while (!state.finished) {
        if (absolute_time_diff_us(get_absolute_time(), deadline) < 0) {
            state_fail(&state);
            break;
        }
        cyw43_arch_poll();
        sleep_ms(1);
    }

    cyw43_arch_lwip_begin();
    if (state.pcb != NULL) {
        altcp_arg(state.pcb, NULL);
        altcp_recv(state.pcb, NULL);
        altcp_err(state.pcb, NULL);
        if (altcp_close(state.pcb) != ERR_OK) {
            altcp_abort(state.pcb);
        }
        state.pcb = NULL;
    }
    cyw43_arch_lwip_end();

    result.status = state.failed && state.status == 0 ? -1 : state.status;
    result.body_bytes = state.body_bytes;
    result.sink_aborted = state.sink_aborted;
    return result;
}

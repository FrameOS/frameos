#include "pk_http.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "lwip/dns.h"
#include "lwip/pbuf.h"
#include "lwip/tcp.h"
#include "pico/cyw43_arch.h"
#include "pico/stdlib.h"

#define PK_HTTP_HEADER_MAX 1024

typedef struct {
    const pk_http_request_t *request;
    struct tcp_pcb *pcb;
    ip_addr_t addr;
    bool dns_done;
    bool connected;
    bool finished;
    bool failed;
    bool headers_done;
    bool sink_aborted;
    int status;
    size_t body_bytes;
    // Status line + headers accumulate here until the blank line; the body
    // never touches this buffer.
    char header[PK_HTTP_HEADER_MAX];
    size_t header_len;
    char host[128];
    char path[256];
    uint16_t port;
} pk_http_state_t;

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
    } else {
        return false;
    }
    const char *slash = strchr(rest, '/');
    const char *host_end = slash ? slash : rest + strlen(rest);
    const char *colon = memchr(rest, ':', (size_t)(host_end - rest));
    state->port = 80;
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
    return url != NULL && strncmp(url, "http://", 7) == 0;
}

static err_t on_recv(void *arg, struct tcp_pcb *pcb, struct pbuf *p, err_t err)
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
            // Append into the header buffer until the \r\n\r\n terminator.
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
            // Bytes past the header terminator within what we consumed are
            // body; anything we did not copy (take < len) is body too.
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
    tcp_recved(pcb, p->tot_len);
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

static err_t on_connected(void *arg, struct tcp_pcb *pcb, err_t err)
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
        tcp_write(pcb, request, (u16_t)len, TCP_WRITE_FLAG_COPY) != ERR_OK) {
        state_fail(state);
        return ERR_ABRT;
    }
    tcp_output(pcb);
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
        state.pcb = tcp_new_ip_type(IP_GET_TYPE(&state.addr));
        if (state.pcb == NULL) {
            state_fail(&state);
        } else {
            tcp_arg(state.pcb, &state);
            tcp_recv(state.pcb, on_recv);
            tcp_err(state.pcb, on_err);
            if (tcp_connect(state.pcb, &state.addr, state.port, on_connected) != ERR_OK) {
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
        tcp_arg(state.pcb, NULL);
        tcp_recv(state.pcb, NULL);
        tcp_err(state.pcb, NULL);
        if (tcp_close(state.pcb) != ERR_OK) {
            tcp_abort(state.pcb);
        }
        state.pcb = NULL;
    }
    cyw43_arch_lwip_end();

    result.status = state.failed && state.status == 0 ? -1 : state.status;
    result.body_bytes = state.body_bytes;
    result.sink_aborted = state.sink_aborted;
    return result;
}

#include "pk_httpd.h"

#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "lwip/tcp.h"
#include "pico/cyw43_arch.h"

#include "pk_bmp.h"
#include "pk_config.h"
#include "pk_config_keys.h"
#include "pk_display.h"
#include "pk_hotspot.h"
#include "pk_httpd_parse.h"
#include "pk_log.h"
#include "pk_render.h"
#include "pk_status.h"
#include "pk_wifi.h"

#define HTTPD_PORT 80
#define HTTPD_MAX_CONNECTIONS 4
#define HTTPD_REQUEST_MAX 4096
#define HTTPD_PAGE_MAX 8192
#define HTTPD_IDLE_POLLS 20 // × 0.5 s × tcp_poll interval 2 = 20 s

typedef struct {
    struct tcp_pcb *pcb;
    char *request;
    size_t request_len;
    bool responding;
    char *response; // headers + body, heap
    size_t response_len;
    size_t response_sent;
    // GET /image streams rows out of the frame buffer after `response`.
    const uint8_t *image;
    int image_format;
    int image_width;
    int image_height;
    int image_row;
    uint8_t idle_polls;
} conn_t;

static struct tcp_pcb *s_listener = NULL;
static int s_connections = 0;
static pk_httpd_action_t s_action = PK_HTTPD_ACTION_NONE;

static void request_action(pk_httpd_action_t action)
{
    if (action > s_action) s_action = action;
}

pk_httpd_action_t pk_httpd_take_action(void)
{
    pk_httpd_action_t action = s_action;
    s_action = PK_HTTPD_ACTION_NONE;
    return action;
}

// ------------------------------------------------------ connection plumbing

static void conn_free(conn_t *conn)
{
    free(conn->request);
    free(conn->response);
    free(conn);
    s_connections--;
}

// Closes (or aborts) and frees. Returns what the calling lwIP callback must
// return: ERR_ABRT when the pcb was aborted from inside it.
static err_t conn_close(conn_t *conn)
{
    struct tcp_pcb *pcb = conn->pcb;
    tcp_arg(pcb, NULL);
    tcp_recv(pcb, NULL);
    tcp_sent(pcb, NULL);
    tcp_err(pcb, NULL);
    tcp_poll(pcb, NULL, 0);
    conn_free(conn);
    if (tcp_close(pcb) != ERR_OK) {
        tcp_abort(pcb);
        return ERR_ABRT;
    }
    return ERR_OK;
}

// Queues as much of the response as the send buffer takes. Returns true once
// everything is queued (the connection can close; lwIP flushes before FIN).
static bool conn_send(conn_t *conn)
{
    struct tcp_pcb *pcb = conn->pcb;
    while (conn->response_sent < conn->response_len) {
        size_t room = tcp_sndbuf(pcb);
        size_t chunk = conn->response_len - conn->response_sent;
        if (chunk > room) chunk = room;
        if (chunk > 2 * TCP_MSS) chunk = 2 * TCP_MSS;
        if (chunk == 0) break;
        if (tcp_write(pcb, conn->response + conn->response_sent, (u16_t)chunk, TCP_WRITE_FLAG_COPY) != ERR_OK) {
            break; // out of pbufs for now: the sent/poll callback resumes
        }
        conn->response_sent += chunk;
    }
    if (conn->response_sent == conn->response_len && conn->image != NULL) {
        static uint8_t row[512];
        size_t row_bytes = pk_bmp_row_bytes(conn->image_format, conn->image_width);
        size_t packed_bytes = pk_fosb_row_bytes(conn->image_format, conn->image_width);
        while (conn->image_row < conn->image_height && tcp_sndbuf(pcb) >= row_bytes) {
            pk_bmp_row(conn->image_format, conn->image_width,
                       conn->image + (size_t)conn->image_row * packed_bytes, row);
            if (tcp_write(pcb, row, (u16_t)row_bytes, TCP_WRITE_FLAG_COPY) != ERR_OK) break;
            conn->image_row++;
        }
    }
    tcp_output(pcb);
    return conn->response_sent == conn->response_len &&
           (conn->image == NULL || conn->image_row >= conn->image_height);
}

static void respond(conn_t *conn, const char *status, const char *content_type,
                    const char *extra_headers, const char *body, size_t body_len, size_t declared_len)
{
    char head[384];
    int head_len = snprintf(head, sizeof(head),
                            "HTTP/1.1 %s\r\nContent-Type: %s\r\nContent-Length: %u\r\n"
                            "Connection: close\r\nCache-Control: no-store\r\n%s\r\n",
                            status, content_type, (unsigned)declared_len, extra_headers ? extra_headers : "");
    if (head_len < 0 || (size_t)head_len >= sizeof(head)) head_len = 0;
    conn->response = malloc((size_t)head_len + body_len + 1);
    if (conn->response == NULL) {
        conn->response_len = 0;
        conn->responding = true;
        return;
    }
    memcpy(conn->response, head, (size_t)head_len);
    if (body_len) memcpy(conn->response + head_len, body, body_len);
    conn->response_len = (size_t)head_len + body_len;
    conn->response[conn->response_len] = '\0'; // the HEAD path searches it as a string
    conn->responding = true;
}

static void respond_text(conn_t *conn, const char *status, const char *text)
{
    respond(conn, status, "text/plain; charset=utf-8", NULL, text, strlen(text), strlen(text));
}

static void respond_json(conn_t *conn, const char *json)
{
    respond(conn, "200 OK", "application/json", NULL, json, strlen(json), strlen(json));
}

// ------------------------------------------------------------ setup page

typedef struct {
    char *data;
    size_t len;
    size_t cap;
} page_t;

static void page_add(page_t *page, const char *fmt, ...) __attribute__((format(printf, 2, 3)));
static void page_add(page_t *page, const char *fmt, ...)
{
    if (page->len + 1 >= page->cap) return;
    va_list args;
    va_start(args, fmt);
    int written = vsnprintf(page->data + page->len, page->cap - page->len, fmt, args);
    va_end(args);
    if (written > 0) {
        page->len += (size_t)written < page->cap - page->len ? (size_t)written : page->cap - page->len - 1;
    }
}

static const char *escaped(const char *text)
{
    // One value at a time: page_add() copies it before the next call.
    static char buffer[PK_URL_LEN * 6];
    pk_html_escape(text, buffer, sizeof(buffer));
    return buffer;
}

static char *build_page(size_t *out_len)
{
    const pk_config_t *config = pk_config();
    const pk_render_stats_t *render = pk_render_stats();
    page_t page = {.data = malloc(HTTPD_PAGE_MAX), .len = 0, .cap = HTTPD_PAGE_MAX};
    if (page.data == NULL) return NULL;
    bool portal = pk_wifi_portal_active();

    // Inputs at 1rem: anything under 16px makes the iOS captive-portal sheet
    // zoom the page when a field takes focus.
    page_add(&page,
             "<!doctype html><html><head><meta charset=\"utf-8\">"
             "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
             "<title>FrameOS setup</title><style>"
             "body{font:1rem system-ui,sans-serif;max-width:32rem;margin:1.5rem auto;padding:0 1rem;color:#111}"
             "h1{font-size:1.4rem}label{display:block;margin:.8rem 0 .2rem;font-weight:600}"
             "input,select,button{font-size:1rem;width:100%%;box-sizing:border-box;padding:.55rem}"
             "button{margin-top:1rem;background:#111;color:#fff;border:0;border-radius:.4rem}"
             "dl{display:grid;grid-template-columns:auto 1fr;gap:.2rem .8rem;font-size:.9rem}"
             "dt{color:#555}small{color:#555}.row{display:flex;gap:.6rem}"
             "</style></head><body><h1>FrameOS</h1><dl>");
    page_add(&page, "<dt>Firmware</dt><dd>%s (%s)</dd>", FRAMEOS_VERSION, escaped(config->hardware_preset[0] ? config->hardware_preset : "custom board"));
    page_add(&page, "<dt>Wi-Fi</dt><dd>%s</dd>",
             portal ? "setup hotspot" : pk_wifi_connected() ? escaped(config->wifi_ssid) : "not connected");
    page_add(&page, "<dt>Backend</dt><dd>%s</dd>", config->backend_url[0] ? escaped(config->backend_url) : "not set");
    page_add(&page, "<dt>Renders</dt><dd>%lu</dd>", (unsigned long)render->count);
    if (render->last_error[0]) page_add(&page, "<dt>Last error</dt><dd>%s</dd>", escaped(render->last_error));
    page_add(&page, "</dl><form method=\"post\" action=\"/api/setup\">");

    page_add(&page, "<label for=\"s\">Wi-Fi network</label>"
                    "<input id=\"s\" name=\"wifi_ssid\" list=\"n\" value=\"%s\" autocapitalize=\"none\" autocorrect=\"off\">"
                    "<datalist id=\"n\">", escaped(config->wifi_ssid));
    // Only the hotspot has a list to offer (taken before it came up): a scan
    // from here would wait inside a network callback.
    size_t count = 0;
    const pk_wifi_network_t *networks = portal ? pk_wifi_scan(&count) : NULL;
    for (size_t i = 0; i < count; i++) {
        page_add(&page, "<option value=\"%s\">", escaped(networks[i].ssid));
    }
    page_add(&page, "</datalist><label for=\"p\">Wi-Fi password</label>"
                    "<input id=\"p\" name=\"wifi_pass\" type=\"password\" placeholder=\"%s\">",
             config->wifi_pass[0] ? "(unchanged)" : "");
    page_add(&page, "<label for=\"b\">FrameOS backend URL</label>"
                    "<input id=\"b\" name=\"backend\" value=\"%s\" placeholder=\"http://192.168.1.10:8989\" "
                    "autocapitalize=\"none\" autocorrect=\"off\">", escaped(config->backend_url));
    page_add(&page, "<div class=\"row\"><div><label for=\"f\">Frame ID</label>"
                    "<input id=\"f\" name=\"frame_id\" inputmode=\"numeric\" value=\"%lu\"></div>",
             (unsigned long)config->frame_id);
    page_add(&page, "<div><label for=\"k\">Frame API key</label>"
                    "<input id=\"k\" name=\"api_key\" type=\"password\" placeholder=\"%s\"></div></div>",
             config->api_key[0] ? "(unchanged)" : "");
    page_add(&page, "<label for=\"h\">Board</label><select id=\"h\" name=\"hardware\">"
                    "<option value=\"\">%s</option>",
             config->hardware_preset[0] ? "(unchanged)" : "Custom wiring (set over USB)");
    size_t preset_count = 0;
    const pk_preset_t *presets = pk_config_presets(&preset_count);
    for (size_t i = 0; i < preset_count; i++) {
        page_add(&page, "<option value=\"%s\"%s>%s</option>", presets[i].name,
                 strcmp(presets[i].name, config->hardware_preset) == 0 ? " selected" : "", presets[i].name);
    }
    page_add(&page, "</select><button type=\"submit\">Save and restart</button>"
                    "<p><small>The frame's deploy panel in FrameOS shows the backend URL, frame ID and "
                    "API key — or sets all of this for you over USB.</small></p></form>");
    if (!portal) {
        page_add(&page, "<form method=\"post\" action=\"/api/action/render\">"
                        "<button type=\"submit\">Render now</button></form>");
    }
    page_add(&page, "</body></html>");
    *out_len = page.len;
    return page.data;
}

// A field the form left empty keeps its current value; hardware goes first
// because a preset rewrites panel and pins.
static bool apply_setup_form(const char *body, size_t len, char *error, size_t error_cap)
{
    static const char *const fields[] = {"hardware", "wifi_ssid", "wifi_pass", "backend", "frame_id", "api_key"};
    static pk_config_t next; // ~900 bytes: not on a callback's stack
    next = *pk_config();
    for (size_t i = 0; i < sizeof(fields) / sizeof(fields[0]); i++) {
        char value[PK_URL_LEN];
        if (!pk_httpd_form_value(body, len, fields[i], value, sizeof(value)) || value[0] == '\0') continue;
        char message[96];
        pk_set_result_t result =
            pk_config_set(&next, fields[i], value, pk_display_panel_known, message, sizeof(message));
        if (result == PK_SET_INVALID || result == PK_SET_UNKNOWN_KEY) {
            snprintf(error, error_cap, "%s: %s", fields[i], message);
            return false;
        }
    }
    *pk_config() = next;
    if (!pk_config_save()) {
        snprintf(error, error_cap, "could not write the settings to flash");
        return false;
    }
    return true;
}

// ---------------------------------------------------------------- routing

static void respond_log_write(void *arg, const char *data, size_t len)
{
    page_t *page = arg;
    if (page->len + len >= page->cap) return;
    memcpy(page->data + page->len, data, len);
    page->len += len;
}

static void route(conn_t *conn, const pk_httpd_request_t *request, const char *body, size_t body_len)
{
    const pk_config_t *config = pk_config();
    bool portal = pk_wifi_portal_active();
    bool get = strcmp(request->method, "GET") == 0 || strcmp(request->method, "HEAD") == 0;
    bool post = strcmp(request->method, "POST") == 0;
    const char *path = request->path;
    if (portal) pk_wifi_portal_note_activity();

    // The backend (and the Pi runtime's API shape) also address a frame as
    // /api/frames/<id>/…; the id is this board either way.
    if (strncmp(path, "/api/frames/", 12) == 0) {
        const char *rest = path + 12;
        while (*rest >= '0' && *rest <= '9') rest++;
        if (rest != path + 12 && (*rest == '/' || *rest == '\0')) path = *rest ? rest : "/";
    }

    if (get && strcmp(path, "/ping") == 0) {
        respond_text(conn, "200 OK", "pong");
        return;
    }

    if (!portal && !pk_httpd_authorized(request, config)) {
        if (!config->api_key[0] && !(config->admin_auth && config->admin_user[0])) {
            respond_text(conn, "403 Forbidden",
                         "This frame has no API key or device login yet. Provision it over USB or "
                         "through its setup hotspot.");
        } else {
            respond(conn, "401 Unauthorized", "text/plain; charset=utf-8",
                    "WWW-Authenticate: Basic realm=\"FrameOS\"\r\n", "Unauthorized", 12, 12);
        }
        return;
    }

    if (get && strcmp(path, "/") == 0) {
        size_t len = 0;
        char *html = build_page(&len);
        if (html == NULL) {
            respond_text(conn, "503 Service Unavailable", "out of memory");
            return;
        }
        respond(conn, "200 OK", "text/html; charset=utf-8", NULL, html, len, len);
        free(html);
    } else if (get && strcmp(path, "/status") == 0) {
        static char json[PK_STATUS_JSON_MAX];
        if (pk_status_json(json, sizeof(json)) == 0) respond_text(conn, "500 Internal Server Error", "status too large");
        else respond_json(conn, json);
    } else if (get && strcmp(path, "/logs") == 0) {
        page_t logs = {.data = malloc(PK_LOG_SLOTS * (PK_LOG_LINE_MAX + 16)), .len = 0,
                       .cap = PK_LOG_SLOTS * (PK_LOG_LINE_MAX + 16)};
        if (logs.data == NULL) {
            respond_text(conn, "503 Service Unavailable", "out of memory");
            return;
        }
        pk_log_dump(respond_log_write, &logs);
        respond(conn, "200 OK", "text/plain; charset=utf-8", NULL, logs.data, logs.len, logs.len);
        free(logs.data);
    } else if (get && strcmp(path, "/image") == 0) {
        int format, width, height;
        const uint8_t *frame = pk_render_framebuffer(&format, &width, &height);
        uint8_t header[PK_BMP_HEADER_MAX];
        size_t header_len = frame ? pk_bmp_header(format, width, height, header) : 0;
        if (header_len == 0) {
            respond_text(conn, "404 Not Found",
                         "No image held on this board (nothing rendered since boot, or a build "
                         "without a frame buffer).");
            return;
        }
        respond(conn, "200 OK", "image/bmp", NULL, (const char *)header, header_len,
                pk_bmp_total_bytes(format, width, height));
        conn->image = frame;
        conn->image_format = format;
        conn->image_width = width;
        conn->image_height = height;
    } else if (post && strcmp(path, "/api/setup") == 0) {
        char error[160];
        if (apply_setup_form(body, body_len, error, sizeof(error))) {
            pk_logf("setup: settings saved from the setup page, restarting");
            static const char saved[] =
                "<!doctype html><meta name=\"viewport\" content=\"width=device-width\">"
                "<p style=\"font:1rem system-ui;margin:2rem\">Saved. The frame is restarting and "
                "will join your Wi-Fi; this hotspot goes away.</p>";
            respond(conn, "200 OK", "text/html; charset=utf-8", NULL, saved, sizeof(saved) - 1,
                    sizeof(saved) - 1);
            request_action(PK_HTTPD_ACTION_RESTART);
        } else {
            respond_text(conn, "400 Bad Request", error);
        }
    } else if (post && (strcmp(path, "/api/action/render") == 0 || strcmp(path, "/reload") == 0 ||
                        strncmp(path, "/event/", 7) == 0)) {
        request_action(PK_HTTPD_ACTION_RENDER);
        respond_json(conn, "{\"status\":\"ok\"}");
    } else if (post && (strcmp(path, "/api/action/restart") == 0 || strcmp(path, "/api/action/reboot") == 0)) {
        request_action(PK_HTTPD_ACTION_RESTART);
        respond_json(conn, "{\"status\":\"ok\"}");
    } else if (portal && get) {
        // Captive-portal probes (/generate_204, /hotspot-detect.html,
        // /connecttest.txt, …) and everything else a phone asks for.
        respond(conn, "302 Found", "text/plain", "Location: http://" PK_HOTSPOT_IP_STRING "/\r\n", "", 0, 0);
    } else {
        respond_text(conn, "404 Not Found", "Not found");
    }
}

// --------------------------------------------------------- lwIP callbacks

static err_t finish_if_sent(conn_t *conn)
{
    if (conn->responding && conn_send(conn)) return conn_close(conn);
    return ERR_OK;
}

static err_t on_recv(void *arg, struct tcp_pcb *pcb, struct pbuf *p, err_t err)
{
    conn_t *conn = arg;
    if (p == NULL || err != ERR_OK) {
        if (p != NULL) pbuf_free(p);
        return conn_close(conn);
    }
    tcp_recved(pcb, p->tot_len);
    if (!conn->responding) {
        size_t room = HTTPD_REQUEST_MAX - conn->request_len;
        size_t take = p->tot_len < room ? p->tot_len : room;
        pbuf_copy_partial(p, conn->request + conn->request_len, (u16_t)take, 0);
        conn->request_len += take;
        conn->request[conn->request_len] = '\0';
        bool overflow = p->tot_len > room;

        pk_httpd_request_t request;
        pk_httpd_parse_t parsed = pk_httpd_parse(conn->request, conn->request_len, &request);
        if (parsed == PK_HTTPD_READY) {
            route(conn, &request, conn->request + request.body_offset, request.content_length);
            if (strcmp(request.method, "HEAD") == 0 && conn->response != NULL) {
                // Headers only: cut the body off what route() built.
                char *end = strstr(conn->response, "\r\n\r\n");
                if (end) conn->response_len = (size_t)(end - conn->response) + 4;
                conn->image = NULL;
            }
        } else if (parsed == PK_HTTPD_BAD_REQUEST) {
            respond_text(conn, "400 Bad Request", "Bad request");
        } else if (overflow || conn->request_len >= HTTPD_REQUEST_MAX) {
            respond_text(conn, "413 Payload Too Large", "Request too large");
        }
    }
    pbuf_free(p);
    conn->idle_polls = 0;
    return finish_if_sent(conn);
}

static err_t on_sent(void *arg, struct tcp_pcb *pcb, u16_t len)
{
    (void)pcb;
    (void)len;
    conn_t *conn = arg;
    conn->idle_polls = 0;
    return finish_if_sent(conn);
}

static err_t on_poll(void *arg, struct tcp_pcb *pcb)
{
    (void)pcb;
    conn_t *conn = arg;
    if (++conn->idle_polls > HTTPD_IDLE_POLLS) {
        return conn_close(conn); // a client that went quiet
    }
    return finish_if_sent(conn);
}

static void on_error(void *arg, err_t err)
{
    (void)err;
    conn_t *conn = arg; // the pcb is already gone
    if (conn != NULL) conn_free(conn);
}

static err_t on_accept(void *arg, struct tcp_pcb *pcb, err_t err)
{
    (void)arg;
    if (err != ERR_OK || pcb == NULL) return ERR_VAL;
    if (s_connections >= HTTPD_MAX_CONNECTIONS) {
        tcp_abort(pcb);
        return ERR_ABRT;
    }
    conn_t *conn = calloc(1, sizeof(conn_t));
    if (conn != NULL) conn->request = malloc(HTTPD_REQUEST_MAX + 1);
    if (conn == NULL || conn->request == NULL) {
        free(conn);
        tcp_abort(pcb);
        return ERR_ABRT;
    }
    s_connections++;
    conn->pcb = pcb;
    tcp_arg(pcb, conn);
    tcp_recv(pcb, on_recv);
    tcp_sent(pcb, on_sent);
    tcp_err(pcb, on_error);
    tcp_poll(pcb, on_poll, 2);
    return ERR_OK;
}

bool pk_httpd_start(void)
{
    if (s_listener != NULL) return true;
    cyw43_arch_lwip_begin();
    struct tcp_pcb *pcb = tcp_new_ip_type(IPADDR_TYPE_ANY);
    if (pcb != NULL && tcp_bind(pcb, IP_ANY_TYPE, HTTPD_PORT) == ERR_OK) {
        // On success the original pcb is freed and a smaller one returned.
        s_listener = tcp_listen_with_backlog(pcb, HTTPD_MAX_CONNECTIONS);
        if (s_listener != NULL) tcp_accept(s_listener, on_accept);
        else tcp_close(pcb);
    } else if (pcb != NULL) {
        tcp_close(pcb);
    }
    cyw43_arch_lwip_end();
    if (s_listener == NULL) pk_logf("http: could not listen on port %d", HTTPD_PORT);
    return s_listener != NULL;
}

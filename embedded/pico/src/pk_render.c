#include "pk_render.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "hardware/flash.h"
#include "hardware/sync.h"
#include "pico/stdlib.h"

#include "pk_config.h"
#include "pk_display.h"
#include "pk_flash_layout.h"
#include "pk_fosb.h"
#include "pk_hash.h"
#include "pk_http.h"
#include "pk_json.h"
#include "pk_leds.h"
#include "pk_log.h"
#include "pk_platform.h"
#include "pk_settings_parse.h"
#include "pk_state.h"
#include "pk_status_screen.h"
#include "pk_wifi.h"

#define RENDER_TIMEOUT_MS 120000
#define SETTINGS_TIMEOUT_MS 30000
#define SETTINGS_MAX_BYTES (24u * 1024u) // the document carries a TLS PEM pair for other boards
#define LOG_TIMEOUT_MS 15000
#define LOG_BATCH_BYTES (6u * 1024u)     // header + body must fit TCP_SND_BUF
#define LOG_MAX_BATCHES 4

#if PK_FRAMEBUFFER_BYTES > 0
static uint8_t s_framebuffer[PK_FRAMEBUFFER_BYTES];
static pk_fosb_header_t s_framebuffer_header;
#endif
static bool s_framebuffer_valid = false;

static pk_render_stats_t s_stats;
static pk_state_t s_state;
static char s_settings_etag[PK_HTTP_ETAG_MAX];

// ------------------------------------------------------- persisted state

static void flash_read(void *ctx, uint32_t offset, uint8_t *dst, size_t len)
{
    (void)ctx;
    memcpy(dst, (const uint8_t *)(XIP_BASE + PK_FLASH_STATE_OFFSET + offset), len);
}

static void flash_erase(void *ctx)
{
    (void)ctx;
    uint32_t interrupts = save_and_disable_interrupts();
    flash_range_erase(PK_FLASH_STATE_OFFSET, FLASH_SECTOR_SIZE);
    restore_interrupts(interrupts);
}

static void flash_program(void *ctx, uint32_t offset, const uint8_t *data)
{
    (void)ctx;
    uint32_t interrupts = save_and_disable_interrupts();
    flash_range_program(PK_FLASH_STATE_OFFSET + offset, data, PK_STATE_PAGE_SIZE);
    restore_interrupts(interrupts);
}

static const pk_state_flash_t s_flash = {
    .ctx = NULL,
    .read = flash_read,
    .erase_sector = flash_erase,
    .program_page = flash_program,
};

void pk_render_init(void)
{
    _Static_assert(PK_STATE_SECTOR_SIZE == FLASH_SECTOR_SIZE, "state log is one flash sector");
    _Static_assert(PK_STATE_PAGE_SIZE == FLASH_PAGE_SIZE, "state log programs whole pages");
    memset(&s_stats, 0, sizeof(s_stats));
    pk_state_load(&s_flash, &s_state);
    s_stats.count = s_state.render_count;
}

const pk_render_stats_t *pk_render_stats(void)
{
    return &s_stats;
}

bool pk_render_panel_shows_scene(void)
{
    return s_state.has_display && s_state.shows_scene;
}

static bool shows(const uint8_t hash[PK_HASH_LEN])
{
    return s_state.has_display && memcmp(s_state.display_hash, hash, PK_HASH_LEN) == 0;
}

static void remember(const uint8_t hash[PK_HASH_LEN], bool scene)
{
    memcpy(s_state.display_hash, hash, PK_HASH_LEN);
    s_state.has_display = 1;
    s_state.shows_scene = scene ? 1 : 0;
    s_state.render_count++;
    s_stats.count = s_state.render_count;
    pk_state_save(&s_flash, &s_state);
}

// ------------------------------------------------------------ FOSB sink

typedef struct {
    const pk_panel_t *panel;
    uint8_t header[PK_FOSB_HEADER_LEN];
    size_t header_len;
    size_t payload_expected;
    size_t payload_written;
    pk_hash_t hash;
    const char *error;
} fosb_sink_t;

static bool fosb_sink(void *arg, const uint8_t *data, size_t len)
{
    fosb_sink_t *sink = arg;
    if (sink->header_len < PK_FOSB_HEADER_LEN) {
        size_t take = PK_FOSB_HEADER_LEN - sink->header_len;
        if (take > len) take = len;
        memcpy(sink->header + sink->header_len, data, take);
        sink->header_len += take;
        data += take;
        len -= take;
        if (sink->header_len < PK_FOSB_HEADER_LEN) return true;

        pk_fosb_header_t header;
        if (pk_fosb_parse_header(sink->header, &header) != PK_FOSB_OK) {
            sink->error = "not a FOSB v1 payload";
            return false;
        }
        if (header.format != sink->panel->format || header.width != sink->panel->width ||
            header.height != sink->panel->height) {
            // The frame's device setting and the board's panel disagree.
            sink->error = "payload does not match the panel (check the frame's device setting)";
            return false;
        }
    }
    size_t room = sink->payload_expected - sink->payload_written;
    if (len > room) len = room; // ignore trailing bytes
    if (len == 0) return true;
    pk_hash_update(&sink->hash, data, len);
#if PK_FRAMEBUFFER_BYTES > 0
    memcpy(s_framebuffer + sink->payload_written, data, len);
#else
    sink->panel->write(data, len);
#endif
    sink->payload_written += len;
    return true;
}

// ------------------------------------------------------------- log lines

static void log_render(const char *event, const char *status, const char *stage, const char *detail)
{
    char escaped[128];
    pk_json_escape(detail ? detail : "", escaped, sizeof(escaped));
    char line[PK_LOG_LINE_MAX];
    snprintf(line, sizeof(line),
             "{\"event\":\"%s\",\"source\":\"pico\",\"status\":\"%s\",\"stage\":\"%s\"%s%s%s}", event,
             status, stage, escaped[0] ? ",\"message\":\"" : "", escaped, escaped[0] ? "\"" : "");
    pk_log_event(line);
}

static void log_metrics(void)
{
    char line[PK_LOG_LINE_MAX];
    snprintf(line, sizeof(line),
             "{\"event\":\"metrics\",\"source\":\"pico\",\"uptimeSeconds\":%lu,\"freeHeapKB\":%lu,"
             "\"wifiRssi\":%d,\"renders\":%lu,\"renderLastMs\":%lu,\"onBattery\":%s}",
             (unsigned long)pk_uptime_seconds(), (unsigned long)(pk_free_heap() / 1024u),
             pk_wifi_rssi_cached(), (unsigned long)s_stats.count, (unsigned long)s_stats.last_ms,
             pk_usb_powered() ? "false" : "true");
    pk_log_event(line);
}

static pk_render_result_t fail(const char *stage, const char *message)
{
    snprintf(s_stats.last_error, sizeof(s_stats.last_error), "%s", message);
    log_render("render:error", "error", stage, message);
    return PK_RENDER_FAILED;
}

// ------------------------------------------------------------ the pass

pk_render_result_t pk_render_once(uint32_t *retry_after_seconds)
{
    pk_config_t *config = pk_config();
    const pk_panel_t *panel = pk_display_current();
    if (!pk_config_backend_ready()) {
        snprintf(s_stats.last_error, sizeof(s_stats.last_error),
                 "backend not configured (set backend/frame_id/api_key)");
        return PK_RENDER_NOT_CONFIGURED;
    }
    if (panel == NULL) {
        snprintf(s_stats.last_error, sizeof(s_stats.last_error),
                 "no panel selected (set panel <key> or set hardware <preset>)");
        return PK_RENDER_NOT_CONFIGURED;
    }
    if (!pk_wifi_connected()) {
        snprintf(s_stats.last_error, sizeof(s_stats.last_error), "Wi-Fi is not connected");
        return PK_RENDER_NOT_CONFIGURED;
    }

    s_stats.busy = true;
    s_stats.passes++;
    s_stats.last_error[0] = '\0';
    pk_leds_activity(PK_LED_BLINK);
    absolute_time_t started = get_absolute_time();
    log_render("render", "preparing", "fetch", NULL);

    fosb_sink_t sink;
    memset(&sink, 0, sizeof(sink));
    sink.panel = panel;
    sink.payload_expected = pk_fosb_payload_size(panel->format, panel->width, panel->height);
    pk_hash_init(&sink.hash);
    pk_render_result_t outcome = PK_RENDER_FAILED;

#if PK_FRAMEBUFFER_BYTES > 0
    if (sink.payload_expected > PK_FRAMEBUFFER_BYTES) {
        outcome = fail("allocate", "panel payload is larger than the frame buffer");
        goto done;
    }
    s_framebuffer_valid = false;
#else
    // Streaming: the controller has to be listening before the first byte
    // arrives, and must not be initialised from inside a network callback.
    if (!panel->begin(panel, &config->pins)) {
        panel->end(&config->pins, false);
        outcome = fail("panel", "panel init failed (busy timeout?)");
        goto done;
    }
#endif

    char url[PK_URL_LEN + 64];
    snprintf(url, sizeof(url), "%s/api/frames/%lu/embedded/render", config->backend_url,
             (unsigned long)config->frame_id);
    pk_http_request_t request = {
        .url = url,
        .bearer_token = config->api_key,
        .timeout_ms = RENDER_TIMEOUT_MS,
        .sink = fosb_sink,
        .sink_arg = &sink,
    };
    pk_http_result_t result = pk_http_request(&request);

    bool whole = result.status == 200 && result.complete && sink.error == NULL &&
                 sink.payload_written == sink.payload_expected;
    if (!whole) {
#if PK_FRAMEBUFFER_BYTES == 0
        panel->end(&config->pins, false);
#endif
        if (result.status == 503) {
            // The backend's render queue is full: keep what the panel shows
            // and come back when it says.
            if (retry_after_seconds) {
                *retry_after_seconds = result.retry_after > 0 ? (uint32_t)result.retry_after : 5;
            }
            log_render("render:skipped", "skipped", "queue", "backend render queue is full");
            outcome = PK_RENDER_RETRY_LATER;
            goto done;
        }
        char message[96];
        if (sink.error) snprintf(message, sizeof(message), "%s", sink.error);
        else if (result.status < 0) snprintf(message, sizeof(message), "cannot reach the backend");
        else if (result.status != 200) snprintf(message, sizeof(message), "backend answered HTTP %d", result.status);
        else snprintf(message, sizeof(message), "incomplete payload (%u of %u bytes)",
                      (unsigned)sink.payload_written, (unsigned)sink.payload_expected);
        outcome = fail("fetch", message);
        goto done;
    }

    uint8_t hash[PK_HASH_LEN];
    pk_hash_final(&sink.hash, hash);
#if PK_FRAMEBUFFER_BYTES > 0
    s_framebuffer_header.format = panel->format;
    s_framebuffer_header.width = panel->width;
    s_framebuffer_header.height = panel->height;
    s_framebuffer_valid = true;
#endif

    if (shows(hash)) {
#if PK_FRAMEBUFFER_BYTES == 0
        panel->end(&config->pins, false);
#endif
        s_stats.last_refresh_skipped = true;
        log_render("render:device", "skipped", "unchanged", NULL);
        outcome = PK_RENDER_UNCHANGED;
    } else {
        log_render("render:device", "refreshing", "panel", NULL);
        bool refreshed;
#if PK_FRAMEBUFFER_BYTES > 0
        refreshed = panel->begin(panel, &config->pins);
        if (refreshed) {
            // In slices, so a slow 3 MHz panel does not starve the network.
            for (size_t offset = 0; offset < sink.payload_expected; offset += 16384) {
                size_t slice = sink.payload_expected - offset;
                if (slice > 16384) slice = 16384;
                panel->write(s_framebuffer + offset, slice);
                pk_poll();
            }
            refreshed = panel->end(&config->pins, true);
        } else {
            panel->end(&config->pins, false);
        }
#else
        refreshed = panel->end(&config->pins, true);
#endif
        if (!refreshed) {
            outcome = fail("panel", "panel refresh timed out");
            goto done;
        }
        s_stats.last_refresh_skipped = false;
        remember(hash, true);
        outcome = PK_RENDER_DONE;
    }
    s_stats.last_ms = (uint32_t)(absolute_time_diff_us(started, get_absolute_time()) / 1000);
    log_render("render:done", "ready", outcome == PK_RENDER_UNCHANGED ? "unchanged" : "refreshed", NULL);
    log_metrics();

done:
    pk_leds_activity(PK_LED_OFF);
    s_stats.busy = false;
    return outcome;
}

const uint8_t *pk_render_framebuffer(int *format, int *width, int *height)
{
#if PK_FRAMEBUFFER_BYTES > 0
    if (!s_framebuffer_valid) return NULL;
    *format = s_framebuffer_header.format;
    *width = s_framebuffer_header.width;
    *height = s_framebuffer_header.height;
    return s_framebuffer;
#else
    (void)format;
    (void)width;
    (void)height;
    return NULL;
#endif
}

// -------------------------------------------------------- status screens

static void status_row(void *ctx, int y, uint8_t *row)
{
    pk_status_screen_row(ctx, y, row);
}

static void show_screen(pk_status_screen_t *screen, const char *what)
{
    pk_config_t *config = pk_config();
    const pk_panel_t *panel = pk_display_current();
    if (panel == NULL) return;

    // The screen's identity is its text: the same setup screen after a reboot
    // is not worth another 25-second refresh.
    pk_hash_t hasher;
    pk_hash_init(&hasher);
    pk_hash_update(&hasher, (const uint8_t *)"status", 6);
    for (int i = 0; i < screen->item_count; i++) {
        pk_hash_update(&hasher, (const uint8_t *)screen->items[i].text, strlen(screen->items[i].text) + 1);
    }
    uint8_t hash[PK_HASH_LEN];
    pk_hash_final(&hasher, hash);
    if (shows(hash)) return;

    s_stats.busy = true;
    pk_leds_activity(PK_LED_BLINK);
    s_framebuffer_valid = false;
    if (pk_display_show_rows(panel, &config->pins, status_row, screen)) {
        remember(hash, false);
        pk_logf("display: %s screen shown", what);
    } else {
        pk_logf("display: %s screen failed (panel busy timeout?)", what);
    }
    pk_leds_activity(PK_LED_OFF);
    s_stats.busy = false;
}

void pk_render_show_portal_screen(const char *ssid, const char *psk, const char *ip)
{
    static pk_status_screen_t screen;
    const pk_panel_t *panel = pk_display_current();
    if (panel == NULL) return;
    pk_status_screen_portal(&screen, panel->width, panel->height, panel->format, ssid, psk, ip);
    show_screen(&screen, "setup");
}

void pk_render_show_message(const char *status, const char *line1, const char *line2,
                            const char *line3)
{
    static pk_status_screen_t screen;
    const pk_panel_t *panel = pk_display_current();
    if (panel == NULL) return;
    const char *lines[3] = {line1, line2, line3};
    pk_status_screen_message(&screen, panel->width, panel->height, panel->format, status, lines, 3);
    show_screen(&screen, "status");
}

// --------------------------------------------------------- settings pull

void pk_render_sync_settings(void)
{
    pk_config_t *config = pk_config();
    if (!pk_config_backend_ready() || !pk_wifi_connected()) return;
    char *body = malloc(SETTINGS_MAX_BYTES);
    if (body == NULL) {
        pk_logf("settings: out of memory");
        return;
    }
    body[0] = '\0';
    pk_http_buffer_t buffer = {.data = body, .cap = SETTINGS_MAX_BYTES, .len = 0};
    char url[PK_URL_LEN + 64];
    snprintf(url, sizeof(url), "%s/api/frames/%lu/embedded/settings", config->backend_url,
             (unsigned long)config->frame_id);
    pk_http_request_t request = {
        .url = url,
        .bearer_token = config->api_key,
        .if_none_match = s_settings_etag,
        .timeout_ms = SETTINGS_TIMEOUT_MS,
        .sink = pk_http_buffer_sink,
        .sink_arg = &buffer,
    };
    pk_http_result_t result = pk_http_request(&request);
    if (result.status == 200 && result.complete) {
        char summary[160];
        unsigned changed = pk_settings_apply(body, buffer.len, config, summary, sizeof(summary));
        if (changed & PK_SETTINGS_INVALID) {
            pk_logf("settings: the backend's document has no frame settings");
        } else {
            snprintf(s_settings_etag, sizeof(s_settings_etag), "%s", result.etag);
            if (changed != 0) {
                bool saved = pk_config_save();
                char escaped[176];
                pk_json_escape(summary, escaped, sizeof(escaped));
                char line[PK_LOG_LINE_MAX];
                snprintf(line, sizeof(line),
                         "{\"event\":\"settings:sync\",\"source\":\"pico\",\"changes\":\"%s\",\"saved\":%s}",
                         escaped, saved ? "true" : "false");
                pk_log_event(line);
            }
        }
    } else if (result.status != 304) {
        if (result.sink_aborted) pk_logf("settings: document is larger than %u bytes", SETTINGS_MAX_BYTES);
        else pk_logf("settings: sync failed (HTTP %d)", result.status);
    }
    free(body);
}

// ------------------------------------------------------------ log upload

void pk_render_flush_logs(void)
{
    pk_config_t *config = pk_config();
    if (!config->send_logs || !pk_config_backend_ready() || !pk_wifi_connected()) return;
    if (!pk_log_upload_pending()) return;
    char *body = malloc(LOG_BATCH_BYTES);
    if (body == NULL) return;
    char url[PK_URL_LEN + 16];
    snprintf(url, sizeof(url), "%s/api/log", config->backend_url);
    for (int batch = 0; batch < LOG_MAX_BATCHES; batch++) {
        uint32_t cursor = 0;
        size_t len = pk_log_build_batch(body, LOG_BATCH_BYTES, &cursor);
        if (len == 0) break;
        pk_http_request_t request = {
            .method = "POST",
            .url = url,
            .bearer_token = config->api_key,
            .content_type = "application/json",
            .body = body,
            .body_len = len,
            .timeout_ms = LOG_TIMEOUT_MS,
        };
        pk_http_result_t result = pk_http_request(&request);
        if (result.status < 200 || result.status >= 300) {
            // Not logged through the ring: a failing upload must not feed
            // the queue it is trying to drain.
            printf("logs: upload failed (HTTP %d)\n", result.status);
            break;
        }
        pk_log_mark_uploaded(cursor);
    }
    free(body);
}

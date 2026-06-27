#include "fos_client.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

#include "esp_crt_bundle.h"
#include "esp_err.h"
#include "esp_heap_caps.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "nvs.h"
#include "esp_sleep.h"
#include "esp_timer.h"
#include "mbedtls/sha256.h"

#include "fos_battery.h"
#include "fos_buttons.h"
#include "fos_config.h"
#include "fos_ota.h"
#include "fos_scenes.h"
#include "fos_wifi.h"
#include "frameos_display.h"
#include "frameos_nim.h"

static const char *TAG = "fos_client";

#define RENDER_NOW_BIT BIT0
#define START_RENDER_LOOP_BIT BIT1
#define CLIENT_TASK_STACK_BYTES 40960

/* Below this charge we stop rendering and sleep long to protect the cell. */
#define FOS_BATTERY_CRITICAL_PCT 3
#define FOS_BATTERY_CRITICAL_SLEEP_SEC (6 * 3600)

/* FrameOS embedded bitmap wire format ("FOSB"):
 * magic[4] ver(u8) format(u8) width(u16le) height(u16le) reserved(u16le),
 * then the packed payload bytes for the current FOS_PIXEL_* format. */
#define FOSB_HEADER_LEN 12
#define FOS_DISPLAY_STATE_MAGIC 0x46534453u /* "FSDS" */
#define FOS_DISPLAY_HASH_LEN 32
#define FOS_DISPLAY_STATE_PANEL_LEN 32
#define FOS_SNAPSHOT_MIN_PSRAM_AFTER_COPY (1024u * 1024u)

typedef struct {
    uint32_t magic;
    uint16_t width;
    uint16_t height;
    uint8_t format;
    uint8_t reserved[3];
    uint32_t len;
    char panel[FOS_DISPLAY_STATE_PANEL_LEN];
    uint8_t sha256[FOS_DISPLAY_HASH_LEN];
} fos_display_state_t;

static EventGroupHandle_t s_events;
static SemaphoreHandle_t s_snapshot_lock;
static uint32_t s_render_count = 0;
static int64_t s_last_render_ms = 0;
static uint8_t *s_last_frame = NULL;
static size_t s_last_frame_len = 0;
static int s_last_frame_width = 0;
static int s_last_frame_height = 0;
static fos_pixel_format_t s_last_frame_format = FOS_PIXEL_1BPP;
static uint32_t s_last_frame_render_count = 0;
static int64_t s_last_frame_render_ms = 0;
static bool s_display_state_loaded = false;
static bool s_display_state_valid = false;
static bool s_last_refresh_skipped = false;
static fos_display_state_t s_display_state;

static void load_display_state(void);

uint32_t fos_client_render_count(void) { return s_render_count; }
int64_t fos_client_last_render_ms(void) { return s_last_render_ms; }
bool fos_client_last_refresh_skipped(void) { return s_last_refresh_skipped; }

const char *fos_client_snapshot_mode(void)
{
    if (!s_snapshot_lock) return "none";
    xSemaphoreTake(s_snapshot_lock, portMAX_DELAY);
    bool has_packed = s_last_frame && s_last_frame_len > 0;
    xSemaphoreGive(s_snapshot_lock);
    if (has_packed) return "packed";
    load_display_state();
    return s_display_state_valid ? "hash-only" : "none";
}

static void sha256_hex(const uint8_t sha[FOS_DISPLAY_HASH_LEN], char out[FOS_DISPLAY_HASH_LEN * 2 + 1])
{
    static const char hex[] = "0123456789abcdef";
    for (size_t i = 0; i < FOS_DISPLAY_HASH_LEN; i++) {
        out[i * 2] = hex[(sha[i] >> 4) & 0x0F];
        out[i * 2 + 1] = hex[sha[i] & 0x0F];
    }
    out[FOS_DISPLAY_HASH_LEN * 2] = '\0';
}

static esp_err_t sha256_buffer(const uint8_t *buf, size_t len, uint8_t out[FOS_DISPLAY_HASH_LEN])
{
    if (!buf || !out) return ESP_ERR_INVALID_ARG;
    mbedtls_sha256_context ctx;
    mbedtls_sha256_init(&ctx);
    int rc = mbedtls_sha256_starts(&ctx, false);
    if (rc == 0) rc = mbedtls_sha256_update(&ctx, buf, len);
    if (rc == 0) rc = mbedtls_sha256_finish(&ctx, out);
    mbedtls_sha256_free(&ctx);
    return rc == 0 ? ESP_OK : ESP_FAIL;
}

static bool display_state_for_buffer(const uint8_t *buf, size_t len, int width, int height,
                                     fos_pixel_format_t format, fos_display_state_t *state)
{
    memset(state, 0, sizeof(*state));
    state->magic = FOS_DISPLAY_STATE_MAGIC;
    state->width = (uint16_t)width;
    state->height = (uint16_t)height;
    state->format = (uint8_t)format;
    state->len = (uint32_t)len;
    strlcpy(state->panel, fos_display_panel_name(0), sizeof(state->panel));
    if (sha256_buffer(buf, len, state->sha256) != ESP_OK) {
        memset(state, 0, sizeof(*state));
        return false;
    }
    return true;
}

static bool display_state_matches(const fos_display_state_t *a, const fos_display_state_t *b)
{
    return a && b &&
        a->magic == FOS_DISPLAY_STATE_MAGIC &&
        b->magic == FOS_DISPLAY_STATE_MAGIC &&
        a->width == b->width &&
        a->height == b->height &&
        a->format == b->format &&
        a->len == b->len &&
        strncmp(a->panel, b->panel, sizeof(a->panel)) == 0 &&
        memcmp(a->sha256, b->sha256, FOS_DISPLAY_HASH_LEN) == 0;
}

static void load_display_state(void)
{
    if (s_display_state_loaded) return;
    s_display_state_loaded = true;
    s_display_state_valid = false;
    nvs_handle_t nvs;
    if (nvs_open("frameos", NVS_READONLY, &nvs) != ESP_OK) return;
    fos_display_state_t state;
    size_t len = sizeof(state);
    esp_err_t err = nvs_get_blob(nvs, "display_state", &state, &len);
    nvs_close(nvs);
    if (err == ESP_OK && len == sizeof(state) && state.magic == FOS_DISPLAY_STATE_MAGIC) {
        s_display_state = state;
        s_display_state_valid = true;
    }
}

static void save_display_state(const fos_display_state_t *state)
{
    if (!state || state->magic != FOS_DISPLAY_STATE_MAGIC) return;
    nvs_handle_t nvs;
    esp_err_t err = nvs_open("frameos", NVS_READWRITE, &nvs);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "display state open failed: %s", esp_err_to_name(err));
        return;
    }
    err = nvs_set_blob(nvs, "display_state", state, sizeof(*state));
    if (err == ESP_OK) err = nvs_commit(nvs);
    nvs_close(nvs);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "display state save failed: %s", esp_err_to_name(err));
    }
}

static bool should_keep_packed_snapshot(size_t len)
{
    size_t free_psram = heap_caps_get_free_size(MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    size_t largest_psram = heap_caps_get_largest_free_block(MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    return largest_psram >= len && free_psram >= len + FOS_SNAPSHOT_MIN_PSRAM_AFTER_COPY;
}

void fos_client_render_now(void)
{
    if (s_events) {
        xEventGroupSetBits(s_events, RENDER_NOW_BIT);
    }
}

static bool json_string_value(const char *json, const char *key, char *out, size_t out_len)
{
    if (!json || !key || !out || out_len == 0) return false;
    out[0] = '\0';

    char pattern[64];
    snprintf(pattern, sizeof(pattern), "\"%s\"", key);
    const char *p = strstr(json, pattern);
    if (!p) return false;
    p = strchr(p + strlen(pattern), ':');
    if (!p) return false;
    p++;
    while (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n') p++;
    if (*p != '"') return false;
    p++;

    size_t used = 0;
    while (*p && *p != '"' && used + 1 < out_len) {
        if (*p == '\\' && p[1]) p++;
        out[used++] = *p++;
    }
    out[used] = '\0';
    return used > 0;
}

static void current_scene_id(char *out, size_t out_len)
{
    if (!out || out_len == 0) return;
    out[0] = '\0';
    json_string_value(frameos_nim_scene_info_json(), "currentSceneId", out, out_len);
}

static void log_render_event(const char *event, const char *scene_id, const char *status,
                             const char *mode, uint32_t count, int64_t ms, int width,
                             int height, fos_pixel_format_t format, size_t bytes,
                             esp_err_t esp_err)
{
    char log_line[512];
    snprintf(log_line, sizeof(log_line),
             "{\"event\":\"%s\",\"source\":\"esp32\",\"sceneId\":\"%s\",\"status\":\"%s\","
             "\"mode\":\"%s\",\"count\":%lu,\"ms\":%lld,\"durationMs\":%lld,"
             "\"width\":%d,\"height\":%d,\"pixelFormat\":%d,\"bytes\":%u,\"espErr\":%d}",
             event, scene_id ? scene_id : "", status ? status : "",
             mode ? mode : "", (unsigned long)count, ms, ms, width, height,
             (int)format, (unsigned)bytes, (int)esp_err);
    frameos_nim_log_hook(log_line);
}

static void store_snapshot(const uint8_t *buf, size_t len, int width, int height,
                           fos_pixel_format_t format, uint32_t render_count,
                           int64_t render_ms)
{
    if (!buf || len == 0 || width <= 0 || height <= 0 || !s_snapshot_lock) return;
    if (!should_keep_packed_snapshot(len)) {
        xSemaphoreTake(s_snapshot_lock, portMAX_DELAY);
        uint8_t *old = s_last_frame;
        s_last_frame = NULL;
        s_last_frame_len = 0;
        s_last_frame_width = width;
        s_last_frame_height = height;
        s_last_frame_format = format;
        s_last_frame_render_count = render_count;
        s_last_frame_render_ms = render_ms;
        xSemaphoreGive(s_snapshot_lock);
        free(old);
        ESP_LOGW(TAG, "preview snapshot kept as hash only: need %u bytes, psram free=%u largest=%u",
                 (unsigned)len,
                 (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT),
                 (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
        return;
    }
    uint8_t *copy = heap_caps_malloc(len, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!copy) copy = malloc(len);
    if (!copy) {
        ESP_LOGW(TAG, "preview snapshot skipped: out of memory for %u bytes", (unsigned)len);
        return;
    }
    memcpy(copy, buf, len);

    xSemaphoreTake(s_snapshot_lock, portMAX_DELAY);
    uint8_t *old = s_last_frame;
    s_last_frame = copy;
    s_last_frame_len = len;
    s_last_frame_width = width;
    s_last_frame_height = height;
    s_last_frame_format = format;
    s_last_frame_render_count = render_count;
    s_last_frame_render_ms = render_ms;
    xSemaphoreGive(s_snapshot_lock);
    free(old);
}

bool fos_client_snapshot_info(int *width, int *height, fos_pixel_format_t *format,
                              size_t *len, uint32_t *render_count, int64_t *render_ms)
{
    if (!s_snapshot_lock) return false;
    xSemaphoreTake(s_snapshot_lock, portMAX_DELAY);
    bool ok = s_last_frame && s_last_frame_len > 0;
    if (ok) {
        if (width) *width = s_last_frame_width;
        if (height) *height = s_last_frame_height;
        if (format) *format = s_last_frame_format;
        if (len) *len = s_last_frame_len;
        if (render_count) *render_count = s_last_frame_render_count;
        if (render_ms) *render_ms = s_last_frame_render_ms;
    }
    xSemaphoreGive(s_snapshot_lock);
    return ok;
}

esp_err_t fos_client_snapshot_copy(uint8_t *out, size_t out_len, int *width, int *height,
                                   fos_pixel_format_t *format, uint32_t *render_count,
                                   int64_t *render_ms)
{
    if (!out || !s_snapshot_lock) return ESP_ERR_INVALID_ARG;
    xSemaphoreTake(s_snapshot_lock, portMAX_DELAY);
    if (!s_last_frame || s_last_frame_len == 0) {
        xSemaphoreGive(s_snapshot_lock);
        return ESP_ERR_NOT_FOUND;
    }
    if (out_len != s_last_frame_len) {
        xSemaphoreGive(s_snapshot_lock);
        return ESP_ERR_INVALID_SIZE;
    }
    memcpy(out, s_last_frame, s_last_frame_len);
    if (width) *width = s_last_frame_width;
    if (height) *height = s_last_frame_height;
    if (format) *format = s_last_frame_format;
    if (render_count) *render_count = s_last_frame_render_count;
    if (render_ms) *render_ms = s_last_frame_render_ms;
    xSemaphoreGive(s_snapshot_lock);
    return ESP_OK;
}

/* ------------------------------------------------------------ remote mode */

static esp_err_t fetch_remote_bitmap(uint8_t *buf, size_t buf_len)
{
    fos_config_t *config = fos_config();
    if (!config->backend_url[0] || config->frame_id == 0) {
        ESP_LOGW(TAG, "remote render: backend not configured");
        return ESP_ERR_INVALID_STATE;
    }
    if (fos_wifi_state() != FOS_WIFI_CONNECTED) {
        return ESP_ERR_INVALID_STATE;
    }

    char url[FOS_URL_LEN + 64];
    snprintf(url, sizeof(url), "%s/api/frames/%lu/embedded/render",
             config->backend_url, (unsigned long)config->frame_id);
    char auth[FOS_STR_LEN + 16];
    snprintf(auth, sizeof(auth), "Bearer %s", config->api_key);

    esp_http_client_config_t http_config = {
        .url = url,
        .timeout_ms = 60000,
        .crt_bundle_attach = esp_crt_bundle_attach,
        .buffer_size = 4096,
    };
    esp_http_client_handle_t client = esp_http_client_init(&http_config);
    if (!client) return ESP_FAIL;
    esp_http_client_set_header(client, "Authorization", auth);

    esp_err_t err = esp_http_client_open(client, 0);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "remote render: connect failed: %s", esp_err_to_name(err));
        esp_http_client_cleanup(client);
        return err;
    }
    int64_t content_length = esp_http_client_fetch_headers(client);
    int status = esp_http_client_get_status_code(client);
    if (status != 200) {
        ESP_LOGE(TAG, "remote render: HTTP %d from %s", status, url);
        esp_http_client_close(client);
        esp_http_client_cleanup(client);
        return ESP_FAIL;
    }

    uint8_t header[FOSB_HEADER_LEN];
    int read = esp_http_client_read(client, (char *)header, sizeof(header));
    if (read != FOSB_HEADER_LEN || memcmp(header, "FOSB", 4) != 0 || header[4] != 1) {
        ESP_LOGE(TAG, "remote render: bad header (read=%d)", read);
        esp_http_client_close(client);
        esp_http_client_cleanup(client);
        return ESP_FAIL;
    }
    int width = header[6] | (header[7] << 8);
    int height = header[8] | (header[9] << 8);
    size_t expected = fos_display_present()
        ? fos_display_buffer_size()
        : (((size_t)width + 7u) / 8u) * (size_t)height;
    int want_format = fos_display_present() ? (int)fos_display_format() : FOS_PIXEL_1BPP;
    bool dims_ok = !fos_display_present()
        || (width == fos_display_width() && height == fos_display_height());
    if (header[5] != want_format || expected != buf_len || !dims_ok) {
        ESP_LOGE(TAG, "remote render: format mismatch (%dx%d fmt=%d, want %u bytes, have %u)",
                 width, height, header[5], (unsigned)expected, (unsigned)buf_len);
        esp_http_client_close(client);
        esp_http_client_cleanup(client);
        return ESP_FAIL;
    }

    size_t received = 0;
    while (received < buf_len) {
        int r = esp_http_client_read(client, (char *)buf + received, buf_len - received);
        if (r <= 0) break;
        received += r;
    }
    esp_http_client_close(client);
    esp_http_client_cleanup(client);
    if (received != buf_len) {
        ESP_LOGE(TAG, "remote render: short read %u/%u", (unsigned)received, (unsigned)buf_len);
        return ESP_FAIL;
    }
    ESP_LOGI(TAG, "remote render: fetched %u bytes (%dx%d, content-length %lld)",
             (unsigned)received, width, height, content_length);
    return ESP_OK;
}

/* ------------------------------------------------------------- the loop */

static esp_err_t render_once(void)
{
    fos_config_t *config = fos_config();
    int64_t start = esp_timer_get_time();

    int width = fos_display_present() ? fos_display_width() : 800;
    int height = fos_display_present() ? fos_display_height() : 480;
    fos_pixel_format_t format = fos_display_present() ? fos_display_format() : FOS_PIXEL_1BPP;
    size_t buf_len = fos_display_present() ? fos_display_buffer_size()
                                           : (((size_t)width + 7u) / 8u) * (size_t)height;
    bool local_render = config->render_mode == FOS_RENDER_LOCAL && frameos_nim_available();
    const char *mode = local_render ? "local" : "remote";
    char scene_id[128];
    current_scene_id(scene_id, sizeof(scene_id));
    log_render_event("render:scene", scene_id, "rendering", mode, s_render_count + 1,
                     0, width, height, format, buf_len, ESP_OK);
    frameos_nim_flush_logs();

    uint8_t *buf = heap_caps_malloc(buf_len, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!buf) buf = malloc(buf_len);
    if (!buf) {
        ESP_LOGE(TAG, "out of memory for %u byte framebuffer", (unsigned)buf_len);
        log_render_event("render:error", scene_id, "error", mode, s_render_count,
                         (esp_timer_get_time() - start) / 1000, width, height,
                         format, buf_len, ESP_ERR_NO_MEM);
        frameos_nim_flush_logs();
        return ESP_ERR_NO_MEM;
    }
    memset(buf, 0xFF, buf_len); /* white */

    esp_err_t err;
    if (local_render) {
        err = frameos_nim_render(buf, buf_len, fos_display_format()) == 0 ? ESP_OK : ESP_FAIL;
        if (err != ESP_OK) ESP_LOGE(TAG, "nim render failed");
    } else {
        if (config->render_mode == FOS_RENDER_LOCAL) {
            ESP_LOGW(TAG, "local render requested but nim runtime unavailable; trying remote");
        }
        err = fetch_remote_bitmap(buf, buf_len);
    }

    fos_display_state_t rendered_state;
    bool rendered_state_valid = err == ESP_OK && fos_display_present() &&
        display_state_for_buffer(buf, buf_len, width, height, format, &rendered_state);
    bool skipped_refresh = false;
    if (err == ESP_OK && fos_display_present()) {
        load_display_state();
        if (rendered_state_valid && s_display_state_valid && display_state_matches(&rendered_state, &s_display_state)) {
            skipped_refresh = true;
            s_last_refresh_skipped = true;
            char sha_hex[FOS_DISPLAY_HASH_LEN * 2 + 1];
            sha256_hex(rendered_state.sha256, sha_hex);
            ESP_LOGI(TAG, "display refresh skipped: packed image unchanged (%.*s)", 12, sha_hex);
        } else {
            err = fos_display_blit(buf, buf_len);
            if (err == ESP_OK && rendered_state_valid) {
                s_display_state = rendered_state;
                s_display_state_valid = true;
                s_last_refresh_skipped = false;
                save_display_state(&rendered_state);
            }
        }
    } else if (err == ESP_OK) {
        ESP_LOGI(TAG, "headless: rendered %u bytes, no panel to blit", (unsigned)buf_len);
    }
    if (err == ESP_OK) {
        if (skipped_refresh && rendered_state_valid) {
            s_display_state = rendered_state;
            s_display_state_valid = true;
        }
        s_render_count++;
        s_last_render_ms = (esp_timer_get_time() - start) / 1000;
        store_snapshot(buf, buf_len, width, height, format, s_render_count, s_last_render_ms);
        ESP_LOGI(TAG, "render #%lu done in %lld ms",
                 (unsigned long)s_render_count, s_last_render_ms);
        if (s_render_count == 1) {
            ESP_LOGI(TAG, "render task stack free at low-water mark: %u bytes",
                     (unsigned)uxTaskGetStackHighWaterMark(NULL));
        }
    }
    int64_t total_ms = (esp_timer_get_time() - start) / 1000;
    current_scene_id(scene_id, sizeof(scene_id));
    log_render_event(err == ESP_OK ? "render:done" : "render:error", scene_id,
                     err == ESP_OK ? "ok" : "error", mode, s_render_count,
                     total_ms, width, height, format, buf_len, err);
    frameos_nim_flush_logs();
    free(buf);
    return err;
}

/* How long to wait before the next render, in seconds.
 *
 * wake_schedule + a synced clock → align to wall-clock interval boundaries
 * (a 1h frame wakes at the top of the hour, a 5min frame on :00/:05/...),
 * which is what makes clock faces tick on time. Otherwise we subtract the
 * time already spent this cycle (boot + Wi-Fi + render) so the period stays
 * ~interval instead of drifting by however long a render took. */
static uint32_t compute_sleep_seconds(uint32_t interval, int64_t cycle_start_us)
{
    fos_config_t *config = fos_config();
    if (interval == 0) interval = 1;
    if (config->wake_schedule && fos_wifi_time_synced()) {
        time_t now = time(NULL);
        if (now > 1000000000) { /* clock actually set, not 1970 */
            uint32_t until = interval - (uint32_t)((uint64_t)now % interval);
            return until == 0 ? interval : until;
        }
    }
    int64_t elapsed_s = (esp_timer_get_time() - cycle_start_us) / 1000000;
    if (elapsed_s < 0) elapsed_s = 0;
    if ((uint32_t)elapsed_s >= interval) return 1;
    return interval - (uint32_t)elapsed_s;
}

static void client_task(void *arg)
{
    fos_config_t *config = fos_config();
    xEventGroupWaitBits(s_events, START_RENDER_LOOP_BIT, pdFALSE, pdFALSE, portMAX_DELAY);
    while (true) {
        int64_t cycle_start = esp_timer_get_time();

        /* Interpreted scenes: pick up backend changes and any payload
         * pushed over HTTP/console since the last pass. Both touch the Nim
         * runtime, so they only ever run here on the render task. */
        if (config->render_mode == FOS_RENDER_LOCAL && frameos_nim_available()) {
            fos_scenes_sync(false);
            fos_scenes_apply_pending();
            fos_scenes_apply_pending_selection();
            fos_buttons_process_events();
        }

        /* Battery guardrail: when the cell is nearly empty, skip the (costly)
         * render + panel refresh and sleep long so a low battery can't keep
         * cycling the display down to a damaging voltage. */
        int battery_pct = fos_battery_present() ? fos_battery_percent() : -1;
        bool battery_critical = battery_pct >= 0 && battery_pct <= FOS_BATTERY_CRITICAL_PCT;
        if (battery_critical) {
            ESP_LOGW(TAG, "battery critical (%d%%); skipping render to protect the cell", battery_pct);
        } else {
            if (fos_ota_busy()) {
                ESP_LOGW(TAG, "OTA in progress; skipping render cycle");
            } else {
                render_once();
            }
        }

        uint32_t interval = config->interval_sec ? config->interval_sec : 300;
        double scene_interval = frameos_nim_scene_interval();
        if (scene_interval >= 1.0 && scene_interval < interval) {
            interval = (uint32_t)scene_interval;
        }
        if (battery_critical && interval < FOS_BATTERY_CRITICAL_SLEEP_SEC) {
            interval = FOS_BATTERY_CRITICAL_SLEEP_SEC;
        }

        uint32_t sleep_s = compute_sleep_seconds(interval, cycle_start);
        if (config->deep_sleep && fos_display_present()) {
            ESP_LOGI(TAG, "deep sleeping for %lu s%s", (unsigned long)sleep_s,
                     config->wake_schedule ? " (wake-on-schedule)" : "");
            /* USB console drops in deep sleep; that's the point (battery). */
            esp_deep_sleep((uint64_t)sleep_s * 1000000ULL);
        }
        /* Wait in 1s slices so scene-dispatched "render" events (QuickJS
         * setting the redraw flag) take effect promptly. */
        uint32_t remaining_ms = sleep_s * 1000;
        while (remaining_ms > 0) {
            uint32_t slice = remaining_ms > 1000 ? 1000 : remaining_ms;
            EventBits_t bits = xEventGroupWaitBits(s_events, RENDER_NOW_BIT, pdTRUE,
                                                   pdFALSE, pdMS_TO_TICKS(slice));
            if (bits & RENDER_NOW_BIT) break;
            if (config->render_mode == FOS_RENDER_LOCAL && frameos_nim_available()) {
                fos_buttons_process_events();
            }
            if (frameos_nim_render_requested()) break;
            remaining_ms -= slice;
        }
    }
}

void fos_client_start(void)
{
    if (s_events) return;
    s_events = xEventGroupCreate();
    s_snapshot_lock = xSemaphoreCreateMutex();
    if (!s_events || !s_snapshot_lock) {
        ESP_LOGE(TAG, "render task init failed: event group or snapshot lock unavailable");
        if (s_events) {
            vEventGroupDelete(s_events);
            s_events = NULL;
        }
        if (s_snapshot_lock) {
            vSemaphoreDelete(s_snapshot_lock);
            s_snapshot_lock = NULL;
        }
        return;
    }
    /* Nim render + pixie + the QuickJS interpreter share this stack; QuickJS
     * is capped at 20KB (fos_qjs_glue.c), 40KB leaves room beneath it. The
     * stack must stay in internal RAM because scene loading reads SPIFFS while
     * the flash cache may be disabled; reserve it early, then resume after
     * HTTP/HTTPS have started. */
    BaseType_t created = xTaskCreate(client_task, "fos_client", CLIENT_TASK_STACK_BYTES,
                                     NULL, 5, NULL);
    if (created != pdPASS) {
        ESP_LOGE(TAG, "render task start failed: internal=%u psram=%u",
                 (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
                 (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM));
        vEventGroupDelete(s_events);
        vSemaphoreDelete(s_snapshot_lock);
        s_events = NULL;
        s_snapshot_lock = NULL;
    } else {
        ESP_LOGI(TAG, "render task allocated");
    }
}

void fos_client_resume(void)
{
    if (s_events) {
        xEventGroupSetBits(s_events, START_RENDER_LOOP_BIT);
        ESP_LOGI(TAG, "render task started");
    }
}

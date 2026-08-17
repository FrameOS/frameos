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
#include "esp_attr.h"
#include "esp_heap_caps.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_system.h"
#include "nvs.h"
#include "esp_sleep.h"
#include "esp_timer.h"
#include "mbedtls/sha256.h"

#include "fos_battery.h"
#include "fos_buttons.h"
#include "fos_cloud.h"
#include "fos_config.h"
#include "fos_framebuffer.h"
#include "fos_mem.h"
#include "fos_ota.h"
#include "fos_scenes.h"
#include "fos_schedule.h"
#include "fos_settings.h"
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

/* A cell reading at least this many mV counts as "running on battery" for
 * deep_sleep_on_battery. It is the best power-source signal we have: no
 * supported board wires VBUS to a readable pin (the PhotoPainter's AXP2101
 * could tell, but nothing reads its status registers yet). A plugged-in,
 * charging frame passes this too — acceptable, deep sleeping while charging
 * costs nothing. */
#define FOS_BATTERY_PRESENT_MV 2500

/* How long to hold the boot open for the provider's management socket before
 * a deep sleep, so queued commands can land (each arriving verb arms the
 * keep-awake hold and cancels this pass's sleep). */
#define FOS_CLOUD_SLEEP_GRACE_SEC 20

/* When a deep-sleeping frame wakes only to check for commands
 * (wake_check_seconds), the scheduled render survives the reboot here; the
 * RTC domain keeps both this variable and the system clock through deep
 * sleep. 0 = unknown, render on the next pass. */
RTC_DATA_ATTR static time_t s_next_render_due;

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
static portMUX_TYPE s_keep_awake_lock = portMUX_INITIALIZER_UNLOCKED;
static uint32_t s_render_count = 0;
static int64_t s_last_render_ms = 0;
static uint8_t *s_last_frame = NULL;
static size_t s_last_frame_len = 0;
static int s_last_frame_width = 0;
static int s_last_frame_height = 0;
static fos_pixel_format_t s_last_frame_format = FOS_PIXEL_1BPP;
static uint32_t s_last_frame_render_count = 0;
static int64_t s_last_frame_render_ms = 0;
static int64_t s_keep_awake_until_us = 0;
static bool s_display_state_loaded = false;
static bool s_display_state_valid = false;
static bool s_last_refresh_skipped = false;
static fos_display_state_t s_display_state;

static void load_display_state(void);

uint32_t fos_client_render_count(void) { return s_render_count; }
int64_t fos_client_last_render_ms(void) { return s_last_render_ms; }
bool fos_client_last_refresh_skipped(void) { return s_last_refresh_skipped; }

/* ------------------------------------------------------------- metrics */

/* One sample per render pass, kept in a small ring for GET /metrics and the
 * cloud get_metrics verb; each sample is also emitted as an `event: metrics`
 * log line, which is how the backend's Metrics panel ingests it. */
#define FOS_METRICS_RING_CAP 32

static SemaphoreHandle_t s_metrics_lock = NULL;
static fos_metrics_sample_t s_metrics_ring[FOS_METRICS_RING_CAP];
static size_t s_metrics_next = 0;
static size_t s_metrics_count = 0;

static void log_metrics_sample(void)
{
    char json[512];
    int battery_pct = fos_battery_present() ? fos_battery_percent() : -1;
    size_t used = (size_t)snprintf(
        json, sizeof(json),
        "{\"event\":\"metrics\",\"source\":\"esp32\","
        "\"uptimeSeconds\":%lld,"
        "\"freeHeapKB\":%u,\"largestHeapBlockKB\":%u,"
        "\"freePsramKB\":%u,\"largestPsramBlockKB\":%u,"
        "\"wifiRssi\":%d,\"renders\":%lu,\"renderLastMs\":%lld,"
        "\"loadedScenes\":%d",
        (long long)(esp_timer_get_time() / 1000000),
        (unsigned)(heap_caps_get_free_size(MALLOC_CAP_INTERNAL) / 1024),
        /* Internal fragmentation, not just the total: TLS wants a contiguous
         * block, so a frame with 50 KB free in 4 KB pieces still cannot open
         * the cloud link. This is the number that explains such a frame. */
        (unsigned)(heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT) / 1024),
        (unsigned)(heap_caps_get_free_size(MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT) / 1024),
        (unsigned)(heap_caps_get_largest_free_block(MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT) / 1024),
        fos_wifi_rssi(), (unsigned long)s_render_count, s_last_render_ms,
        fos_scenes_loaded());
    if (battery_pct >= 0 && used < sizeof(json) - 96) {
        used += (size_t)snprintf(json + used, sizeof(json) - used,
                                 ",\"batteryPercent\":%d,\"batteryMillivolts\":%d",
                                 battery_pct, fos_battery_millivolts());
    }
    if (used < sizeof(json) - 2) {
        snprintf(json + used, sizeof(json) - used, "}");
    } else {
        return; /* truncated JSON is worse than a missing sample */
    }
    frameos_nim_log_hook(json);

    if (s_metrics_lock == NULL) s_metrics_lock = xSemaphoreCreateMutex();
    if (s_metrics_lock == NULL) return;
    char *copy = strdup(json);
    if (copy == NULL) return;
    double now = (double)time(NULL);
    xSemaphoreTake(s_metrics_lock, portMAX_DELAY);
    free(s_metrics_ring[s_metrics_next].json);
    s_metrics_ring[s_metrics_next].json = copy;
    s_metrics_ring[s_metrics_next].timestamp = now;
    s_metrics_next = (s_metrics_next + 1) % FOS_METRICS_RING_CAP;
    if (s_metrics_count < FOS_METRICS_RING_CAP) s_metrics_count++;
    xSemaphoreGive(s_metrics_lock);
}

size_t fos_client_metrics_recent(fos_metrics_sample_t *out, size_t max)
{
    if (out == NULL || max == 0 || s_metrics_lock == NULL) return 0;
    xSemaphoreTake(s_metrics_lock, portMAX_DELAY);
    size_t take = s_metrics_count < max ? s_metrics_count : max;
    size_t start = (s_metrics_next + FOS_METRICS_RING_CAP - take) % FOS_METRICS_RING_CAP;
    size_t copied = 0;
    for (size_t i = 0; i < take; i++) {
        const fos_metrics_sample_t *src = &s_metrics_ring[(start + i) % FOS_METRICS_RING_CAP];
        if (src->json == NULL) continue;
        char *copy = strdup(src->json);
        if (copy == NULL) break;
        out[copied].json = copy;
        out[copied].timestamp = src->timestamp;
        copied++;
    }
    xSemaphoreGive(s_metrics_lock);
    return copied;
}

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

bool fos_client_display_state_ready(void)
{
    load_display_state();
    return s_display_state_valid;
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
    strlcpy(state->panel, fos_display_selected_panel(), sizeof(state->panel));
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

static uint8_t white_fill_for_format(fos_pixel_format_t format)
{
    switch (format) {
        case FOS_PIXEL_2BPP_BWYR:
            return 0x55; /* palette index 1 (white) */
        case FOS_PIXEL_4BPP_7COLOR:
        case FOS_PIXEL_4BPP_SPECTRA6:
            return 0x11; /* palette index 1 (white) */
        default:
            return 0xFF;
    }
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

void fos_client_keep_awake_ms(uint32_t ms)
{
    if (ms == 0) return;
    int64_t until_us = esp_timer_get_time() + (int64_t)ms * 1000;
    portENTER_CRITICAL(&s_keep_awake_lock);
    if (until_us > s_keep_awake_until_us) {
        s_keep_awake_until_us = until_us;
    }
    portEXIT_CRITICAL(&s_keep_awake_lock);
}

static uint32_t keep_awake_remaining_seconds(void)
{
    int64_t until_us;
    portENTER_CRITICAL(&s_keep_awake_lock);
    until_us = s_keep_awake_until_us;
    portEXIT_CRITICAL(&s_keep_awake_lock);

    int64_t now_us = esp_timer_get_time();
    if (until_us <= now_us) return 0;
    int64_t remaining_us = until_us - now_us;
    return (uint32_t)((remaining_us + 999999) / 1000000);
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

RTC_NOINIT_ATTR static uint32_t s_render_recovery_restarts;
RTC_NOINIT_ATTR static uint32_t s_render_recovery_magic;
#define FOS_RENDER_RECOVERY_MAGIC 0x5245434fu /* "RECO" */

static bool s_render_paused_for_memory = false;

static void json_escape_value(const char *src, char *out, size_t out_len)
{
    if (!out || out_len == 0) return;
    out[0] = '\0';
    if (!src) return;

    size_t used = 0;
    for (const unsigned char *p = (const unsigned char *)src; *p && used + 1 < out_len; p++) {
        unsigned char c = *p;
        if (c == '"' || c == '\\') {
            if (used + 2 >= out_len) break;
            out[used++] = '\\';
            out[used++] = (char)c;
        } else if (c == '\n' || c == '\r' || c == '\t') {
            if (used + 2 >= out_len) break;
            out[used++] = '\\';
            out[used++] = c == '\n' ? 'n' : (c == '\r' ? 'r' : 't');
        } else if (c < 0x20) {
            if (used + 6 >= out_len) break;
            int written = snprintf(out + used, out_len - used, "\\u%04x", (unsigned)c);
            if (written != 6) break;
            used += 6;
        } else {
            out[used++] = (char)c;
        }
    }
    out[used] = '\0';
}

static void current_scene_details(char *scene_id, size_t scene_id_len,
                                  char *scene_name, size_t scene_name_len)
{
    if (scene_id && scene_id_len > 0) scene_id[0] = '\0';
    if (scene_name && scene_name_len > 0) scene_name[0] = '\0';
    const char *info = frameos_nim_scene_info_json();
    json_string_value(info, "currentSceneId", scene_id, scene_id_len);
    json_string_value(info, "currentSceneName", scene_name, scene_name_len);
}

/* Defined below, next to the other render helpers. */
static void render_failure_recover(const char *scene_name);

static void log_render_event(const char *event, const char *scene_id,
                             const char *scene_name, const char *status,
                             const char *stage, const char *mode,
                             const char *refresh, const char *reason,
                             uint32_t count, int64_t ms, int width, int height,
                             fos_pixel_format_t format, size_t bytes,
                             esp_err_t esp_err)
{
    char event_esc[64];
    char scene_id_esc[192];
    char scene_name_esc[192];
    char status_esc[64];
    char stage_esc[64];
    char mode_esc[64];
    char refresh_esc[64];
    char reason_esc[96];
    char err_name_esc[64];
    json_escape_value(event, event_esc, sizeof(event_esc));
    json_escape_value(scene_id, scene_id_esc, sizeof(scene_id_esc));
    json_escape_value(scene_name, scene_name_esc, sizeof(scene_name_esc));
    json_escape_value(status, status_esc, sizeof(status_esc));
    json_escape_value(stage, stage_esc, sizeof(stage_esc));
    json_escape_value(mode, mode_esc, sizeof(mode_esc));
    json_escape_value(refresh, refresh_esc, sizeof(refresh_esc));
    json_escape_value(reason, reason_esc, sizeof(reason_esc));
    json_escape_value(esp_err == ESP_OK ? "OK" : esp_err_to_name(esp_err),
                      err_name_esc, sizeof(err_name_esc));

    char log_line[1536];
    snprintf(log_line, sizeof(log_line),
             "{\"event\":\"%s\",\"source\":\"esp32\",\"sceneId\":\"%s\",\"sceneName\":\"%s\","
             "\"status\":\"%s\",\"stage\":\"%s\",\"mode\":\"%s\",\"refresh\":\"%s\","
             "\"reason\":\"%s\",\"count\":%lu,\"ms\":%lld,\"durationMs\":%lld,"
             "\"width\":%d,\"height\":%d,\"pixelFormat\":%d,\"bytes\":%u,"
             "\"loadedScenes\":%d,\"freeHeap\":%u,\"freePsram\":%u,"
             "\"espErr\":%d,\"espErrName\":\"%s\"}",
             event_esc, scene_id_esc, scene_name_esc, status_esc, stage_esc,
             mode_esc, refresh_esc, reason_esc, (unsigned long)count, ms, ms,
             width, height, (int)format, (unsigned)bytes, fos_scenes_loaded(),
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_8BIT),
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT),
             (int)esp_err, err_name_esc);
    frameos_nim_log_hook(log_line);

    /* The structured line above only reaches the serial console at INFO,
     * which the firmware log level (WARN) filters out — anyone watching the
     * USB stream during a deploy sees nothing for the minutes a render
     * takes. Print the key lifecycle moments directly. */
    if (strcmp(event, "render:scene") == 0) {
        printf("render #%lu started: scene \"%s\"\n", (unsigned long)count,
               scene_name && scene_name[0] ? scene_name : scene_id);
    } else if (strcmp(event, "render:device") == 0 &&
               strcmp(status, "refreshing") == 0) {
        printf("render #%lu refreshing display (%lld ms so far)\n",
               (unsigned long)count, ms);
    } else if (strcmp(event, "render:done") == 0) {
        printf("render #%lu done in %lld ms\n", (unsigned long)count, ms);
    } else if (strcmp(event, "render:error") == 0) {
        printf("render #%lu failed at %s: %s\n", (unsigned long)count,
               stage && stage[0] ? stage : "?",
               reason && reason[0] ? reason : esp_err_to_name(esp_err));
    }
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
    uint8_t *copy = fos_big_malloc(len);
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
    uint32_t render_attempt = s_render_count + 1;
    char scene_id[128];
    char scene_name[128];
    current_scene_details(scene_id, sizeof(scene_id), scene_name, sizeof(scene_name));
    log_render_event("render:scene", scene_id, scene_name, "rendering", "start",
                     mode, fos_display_present() ? "pending" : "none", "",
                     render_attempt, 0, width, height, format, buf_len, ESP_OK);
    frameos_nim_flush_logs();

    uint8_t *buf = NULL;
    esp_err_t err;
    if (local_render) {
        err = frameos_nim_render_alloc(&buf, &buf_len, fos_display_format()) == 0 ? ESP_OK : ESP_FAIL;
        if (err != ESP_OK) ESP_LOGE(TAG, "nim render failed");
    } else {
        buf = fos_framebuffer_acquire(buf_len);
        if (!buf) {
            /* Free bytes alone never explained this failure — a C3 with 120 KB
             * free and a largest block of 16 KB cannot hold 96000 contiguous
             * bytes. Print what actually decides it. */
            ESP_LOGE(TAG, "out of memory for %u byte framebuffer "
                          "(internal free=%u largest=%u, psram total=%u, reserved=%u)",
                     (unsigned)buf_len,
                     (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT),
                     (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT),
                     (unsigned)heap_caps_get_total_size(MALLOC_CAP_SPIRAM),
                     (unsigned)fos_framebuffer_reserved_bytes());
            log_render_event("render:error", scene_id, scene_name, "error", "allocate",
                             mode, "none", "out-of-memory", render_attempt,
                             (esp_timer_get_time() - start) / 1000, width, height,
                             format, buf_len, ESP_ERR_NO_MEM);
            frameos_nim_flush_logs();
            return ESP_ERR_NO_MEM;
        }
        memset(buf, white_fill_for_format(format), buf_len);
        if (config->render_mode == FOS_RENDER_LOCAL) {
            ESP_LOGW(TAG, "local render requested but nim runtime unavailable; trying remote");
        }
        err = fetch_remote_bitmap(buf, buf_len);
    }

    int64_t framebuffer_ms = (esp_timer_get_time() - start) / 1000;
    log_render_event("render:framebuffer", scene_id, scene_name,
                     err == ESP_OK ? "rendered" : "error", "framebuffer",
                     mode, fos_display_present() ? "pending" : "none",
                     err == ESP_OK ? "" : "render-failed", render_attempt,
                     framebuffer_ms, width, height, format, buf_len, err);
    frameos_nim_flush_logs();

    fos_display_state_t rendered_state;
    bool rendered_state_valid = err == ESP_OK && fos_display_present() &&
        display_state_for_buffer(buf, buf_len, width, height, format, &rendered_state);
    bool skipped_refresh = false;
    const char *refresh = fos_display_present() ? "pending" : "none";
    if (err == ESP_OK && fos_display_present()) {
        load_display_state();
        if (rendered_state_valid && s_display_state_valid && display_state_matches(&rendered_state, &s_display_state)) {
            skipped_refresh = true;
            s_last_refresh_skipped = true;
            refresh = "skipped";
            char sha_hex[FOS_DISPLAY_HASH_LEN * 2 + 1];
            sha256_hex(rendered_state.sha256, sha_hex);
            ESP_LOGI(TAG, "display refresh skipped: packed image unchanged (%.*s)", 12, sha_hex);
            log_render_event("render:device", scene_id, scene_name, "skipped",
                             "display", mode, refresh, "unchanged",
                             render_attempt, (esp_timer_get_time() - start) / 1000,
                             width, height, format, buf_len, ESP_OK);
            frameos_nim_flush_logs();
        } else {
            refresh = "update";
            log_render_event("render:device", scene_id, scene_name, "refreshing",
                             "display", mode, refresh, "", render_attempt,
                             (esp_timer_get_time() - start) / 1000, width, height,
                             format, buf_len, ESP_OK);
            frameos_nim_flush_logs();
            err = fos_display_blit(buf, buf_len);
            refresh = err == ESP_OK ? "updated" : "failed";
            if (err == ESP_OK && rendered_state_valid) {
                s_display_state = rendered_state;
                s_display_state_valid = true;
                s_last_refresh_skipped = false;
                save_display_state(&rendered_state);
            }
        }
    } else if (err == ESP_OK) {
        ESP_LOGI(TAG, "headless: rendered %u bytes, no panel to blit", (unsigned)buf_len);
        refresh = "none";
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
        s_render_recovery_restarts = 0; /* a good render clears the streak */
        if (s_render_count == 1) {
            ESP_LOGI(TAG, "render task stack free at low-water mark: %u bytes",
                     (unsigned)uxTaskGetStackHighWaterMark(NULL));
        }
    }
    int64_t total_ms = (esp_timer_get_time() - start) / 1000;
    current_scene_details(scene_id, sizeof(scene_id), scene_name, sizeof(scene_name));
    log_render_event(err == ESP_OK ? "render:done" : "render:error", scene_id,
                     scene_name, err == ESP_OK ? "ok" : "error", "complete",
                     mode, refresh, err == ESP_OK ? "" : "render-cycle-failed",
                     err == ESP_OK ? s_render_count : render_attempt, total_ms,
                     width, height, format, buf_len, err);
    frameos_nim_flush_logs();
    /* Returns the reservation to the pool, or frees a one-off allocation —
     * including the Nim renderer's buffer on the local-render path. */
    fos_framebuffer_release(buf);
    if (err != ESP_OK) {
        render_failure_recover(scene_name);
    }
    return err;
}

/* A render that fails without releasing its PSRAM leaves a frame that can do
 * nothing at all: the next render fails the same way, and mbedTLS cannot
 * handshake either (CONFIG_MBEDTLS_EXTERNAL_MEM_ALLOC puts its buffers in
 * PSRAM), so the cloud link stays down and the frame cannot even be told to
 * switch to a lighter scene. Measured on an 8 MB board rendering a heavy
 * scene: the pool drops to ~4 KB at the moment of failure and stays there
 * indefinitely. The only way out was a power cycle.
 *
 * So: after a failed render, check whether the pool came back. If it did,
 * this was an ordinary failure and the frame carries on. If it did not, the
 * runtime is holding memory it will never return, and a reboot is strictly
 * better than a frame that is silently dead — it comes back able to render,
 * able to connect, and able to receive a different scene.
 *
 * The threshold is deliberately far below any working render (which needs
 * megabytes): only a frame that is genuinely stuck reaches it. */
#define FOS_RENDER_RECOVERY_MIN_PSRAM (256 * 1024)
/* Restarting rescues a wedged frame, but a scene that always exhausts memory
 * would restart it forever. After this many consecutive rescues the frame
 * stops rendering instead and stays up: a reachable frame showing a stale
 * image can be given a lighter scene, a rebooting one cannot. Survives the
 * software reset in RTC memory (not a power cycle, which is the right scope —
 * unplugging is how a person says "try again"). */
#define FOS_RENDER_RECOVERY_MAX_RESTARTS 2

/* Called once at startup, before the first render. */
void fos_client_render_recovery_boot(void)
{
    /* A power-on reset means a person intervened, and intervening is how they
     * say "try again" — so the streak starts over.
     *
     * esp_reset_reason(), not the RTC magic below: RTC memory is NOT reliably
     * cleared by a brief unplug. Observed on hardware — a frame paused after
     * repeated out-of-memory renders was unplugged, replugged, and came back
     * still paused, because the counter survived the power interruption. The
     * magic can only detect memory that was never stamped, which is a
     * different (and rarer) thing than a deliberate power cycle. */
    if (esp_reset_reason() == ESP_RST_POWERON) {
        s_render_recovery_magic = FOS_RENDER_RECOVERY_MAGIC;
        s_render_recovery_restarts = 0;
        return;
    }
    if (s_render_recovery_magic != FOS_RENDER_RECOVERY_MAGIC) {
        /* First boot on this board, or RTC memory that was never stamped. */
        s_render_recovery_magic = FOS_RENDER_RECOVERY_MAGIC;
        s_render_recovery_restarts = 0;
        return;
    }
    if (s_render_recovery_restarts >= FOS_RENDER_RECOVERY_MAX_RESTARTS) {
        s_render_paused_for_memory = true;
        ESP_LOGE(TAG, "rendering paused: the active scene exhausted PSRAM %u times in a row. "
                      "The frame stays online so a lighter scene can be assigned; "
                      "select another scene or power-cycle to retry.",
                 (unsigned)s_render_recovery_restarts);
        frameos_nim_log_hook(
            "{\"event\":\"render:paused\",\"source\":\"esp32\","
            "\"reason\":\"psram-exhausted-repeatedly\","
            "\"detail\":\"rendering paused so the frame stays reachable; assign a lighter scene\"}");
        frameos_nim_flush_logs();
    }
}

bool fos_client_render_paused(void) { return s_render_paused_for_memory; }

void fos_client_clear_render_pause(void)
{
    /* A new scene selection or a new payload is the user saying "try this
     * instead", so give rendering another chance. */
    s_render_recovery_restarts = 0;
    if (s_render_paused_for_memory) {
        s_render_paused_for_memory = false;
        ESP_LOGI(TAG, "rendering resumed after a scene change");
    }
}

static void render_failure_recover(const char *scene_name)
{
    size_t free_psram = heap_caps_get_free_size(MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (free_psram >= FOS_RENDER_RECOVERY_MIN_PSRAM) {
        return; /* memory came back; nothing to recover from */
    }
    s_render_recovery_restarts += 1;
    ESP_LOGE(TAG, "render failed and PSRAM did not recover (%u bytes free); "
                  "restarting so the frame can render and reconnect",
             (unsigned)free_psram);
    /* Escaped and bounded: a scene name is user-controlled and goes into a
     * JSON log line that the cloud parses. */
    char scene_esc[128];
    json_escape_value(scene_name ? scene_name : "", scene_esc, sizeof(scene_esc));
    char line[320];
    snprintf(line, sizeof(line),
             "{\"event\":\"render:recover\",\"source\":\"esp32\","
             "\"status\":\"restarting\",\"reason\":\"psram-exhausted\","
             "\"freePsram\":%u,\"sceneName\":\"%s\"}",
             (unsigned)free_psram, scene_esc);
    frameos_nim_log_hook(line);
    frameos_nim_flush_logs();
    /* Give the log upload and any USB reader a moment before the reset. */
    vTaskDelay(pdMS_TO_TICKS(1500));
    esp_restart();
}

static void log_render_skipped(const char *reason, int battery_pct)
{
    fos_config_t *config = fos_config();
    int width = fos_display_present() ? fos_display_width() : 800;
    int height = fos_display_present() ? fos_display_height() : 480;
    fos_pixel_format_t format = fos_display_present() ? fos_display_format() : FOS_PIXEL_1BPP;
    size_t buf_len = fos_display_present() ? fos_display_buffer_size()
                                           : (((size_t)width + 7u) / 8u) * (size_t)height;
    bool local_render = config->render_mode == FOS_RENDER_LOCAL && frameos_nim_available();
    const char *mode = local_render ? "local" : "remote";
    char scene_id[128];
    char scene_name[128];
    char reason_buf[96];
    current_scene_details(scene_id, sizeof(scene_id), scene_name, sizeof(scene_name));
    if (battery_pct >= 0) {
        snprintf(reason_buf, sizeof(reason_buf), "%s:%d%%", reason ? reason : "battery", battery_pct);
    } else {
        snprintf(reason_buf, sizeof(reason_buf), "%s", reason ? reason : "");
    }
    log_render_event("render:skipped", scene_id, scene_name, "skipped", "guard",
                     mode, "none", reason_buf, s_render_count + 1, 0, width,
                     height, format, buf_len, ESP_OK);
    frameos_nim_flush_logs();
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
    /* Set when the sleep wait below broke early on an explicit render signal
     * (cloud/HTTP render verb, button, schedule tick, scene request): the
     * next pass must render even if the wake-check bookkeeping says the
     * scheduled render is not due yet. */
    bool force_render = false;
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

        /* Live settings: pick up backend-side interval/name/render-mode
         * changes without a rebuild. ETag'd, so steady state is a 304. */
        fos_settings_sync(false);

        /* A console `set spill_force` may have changed it since last pass. */
        fos_nim_http_set_spill_force_bytes(config->http_spill_force_bytes);
        /* Same for `set debug`: the per-node memory profile is meant to be
         * switched on over the console mid-flight, without a rebuild. */
        frameos_nim_set_debug(config->debug_logging ? 1 : 0);
        frameos_nim_set_fusion(config->image_fusion ? 1 : 0);
        /* Fallback fit for consumers without their own placement — settings
         * sync, cloud set_settings and the console all write it live. */
        frameos_nim_set_scaling_mode(config->scaling_mode);

        /* Battery guardrail: when the cell is nearly empty, skip the (costly)
         * render + panel refresh and sleep long so a low battery can't keep
         * cycling the display down to a damaging voltage. */
        int battery_pct = fos_battery_present() ? fos_battery_percent() : -1;
        bool battery_critical = battery_pct >= 0 && battery_pct <= FOS_BATTERY_CRITICAL_PCT;
        bool on_battery = fos_battery_present() &&
                          fos_battery_millivolts() >= FOS_BATTERY_PRESENT_MV;
        bool deep_sleep_now =
            config->deep_sleep || (config->deep_sleep_on_battery && on_battery);
        /* A wake-check pass: this deep-sleeping frame woke early (or is held
         * awake) only to check the control plane for commands — the panel's
         * scheduled render is not due yet, so skip the costly refresh. An
         * explicit render signal always wins. */
        time_t wall_now = time(NULL);
        bool clock_ok = fos_wifi_time_synced() && wall_now > 1000000000;
        bool checkin_pass = deep_sleep_now && config->wake_check_sec > 0 &&
                            !force_render && clock_ok &&
                            s_next_render_due > wall_now + 2 &&
                            /* a due date past the longest allowed interval is
                             * garbage (clock jump, stale RTC) — render */
                            s_next_render_due < wall_now + 7 * 86400 + 3600;
        force_render = false;
        bool rendered = false;
        if (s_render_paused_for_memory) {
            /* Paused after repeated PSRAM exhaustion — see
             * fos_client_render_recovery_boot. Skipping the render is what
             * keeps this frame reachable, so it can be handed a lighter
             * scene instead of rebooting forever. */
            log_render_skipped("memory", -1);
        } else if (battery_critical) {
            ESP_LOGW(TAG, "battery critical (%d%%); skipping render to protect the cell", battery_pct);
            log_render_skipped("battery", battery_pct);
        } else if (checkin_pass) {
            ESP_LOGI(TAG, "wake-check pass; next render due in %ld s",
                     (long)(s_next_render_due - wall_now));
            log_render_skipped("wake_check", -1);
        } else {
            if (fos_ota_busy()) {
                ESP_LOGW(TAG, "OTA in progress; skipping render cycle");
                log_render_skipped("ota", -1);
            } else {
                render_once();
                rendered = true;
            }
        }
        log_metrics_sample();
        frameos_nim_flush_logs(); /* the sample must not wait for next pass */

        /* The scene's refreshInterval is authoritative when a scene is
         * loaded and has an opinion (>= 1), matching the Pi runner where
         * the frame-level interval is only the no-scene fallback. Clamped
         * like the settings-pulled interval: a bad value must not park the
         * frame for months. */
        uint32_t interval = config->interval_sec ? config->interval_sec : 300;
        double scene_interval = frameos_nim_scene_interval();
        if (scene_interval >= 1.0) {
            if (scene_interval > 7 * 86400.0) scene_interval = 7 * 86400.0;
            interval = (uint32_t)scene_interval;
        }
        /* A per-render override from logic/nextSleepDuration beats both
         * intervals, like context.nextSleep on the Pi runner. Only valid
         * right after a render actually ran. */
        if (rendered) {
            double next_sleep = frameos_nim_next_sleep();
            if (next_sleep >= 0.0) {
                if (next_sleep > 7 * 86400.0) next_sleep = 7 * 86400.0;
                if (next_sleep < 1.0) next_sleep = 1.0;
                interval = (uint32_t)next_sleep;
            }
        }
        if (battery_critical && interval < FOS_BATTERY_CRITICAL_SLEEP_SEC) {
            interval = FOS_BATTERY_CRITICAL_SLEEP_SEC;
        }

        uint32_t sleep_s = compute_sleep_seconds(interval, cycle_start);
        /* A pass that ran before the scene store finished loading must not
         * park the frame for the whole fallback interval: scenes only load ON
         * a pass, so nothing wakes the loop when they become loadable, and a
         * boot could sit dark for the frame interval looking exactly like a
         * hang (the 2026.8.18 cloud-OTA "stuck frame" report — the panel
         * stayed dark until a manual render command forced a pass). Retry
         * quickly until something is resident; an empty pass costs no panel
         * refresh. Deep-sleep frames are exempt: their wake IS a fresh boot,
         * and short-cycling them would drain the battery. */
        if (!deep_sleep_now && config->render_mode == FOS_RENDER_LOCAL &&
            frameos_nim_available() && fos_scenes_loaded() == 0 &&
            fos_scenes_state_mounted() && sleep_s > 10) {
            ESP_LOGW(TAG, "no scene loaded yet; retrying in 10 s instead of %lu s",
                     (unsigned long)sleep_s);
            sleep_s = 10;
        }
        if (checkin_pass) {
            /* This pass skipped the render, so sleep until the scheduled one,
             * not a fresh interval from now. */
            int64_t until_due = (int64_t)(s_next_render_due - time(NULL));
            if (until_due < 1) until_due = 1;
            if ((uint64_t)until_due < sleep_s) sleep_s = (uint32_t)until_due;
        }
        ESP_LOGI(TAG, "next render in %lu s (interval %lu s)",
                 (unsigned long)sleep_s, (unsigned long)interval);
        uint32_t keep_awake_s = keep_awake_remaining_seconds();
        if (deep_sleep_now && fos_display_present() && keep_awake_s == 0 &&
            fos_cloud_state() == FOS_CLOUD_ENROLLED && fos_wifi_ip()[0] != '\0' &&
            !fos_cloud_ws_connected()) {
            /* Hold the boot open briefly for the provider's management socket
             * so queued commands can land before the deep sleep kills it. An
             * arriving verb arms the keep-awake hold, which cancels this
             * pass's deep sleep below. */
            int64_t grace_end = esp_timer_get_time() +
                                (int64_t)FOS_CLOUD_SLEEP_GRACE_SEC * 1000000LL;
            while (!fos_cloud_ws_connected() && esp_timer_get_time() < grace_end &&
                   keep_awake_remaining_seconds() == 0) {
                vTaskDelay(pdMS_TO_TICKS(500));
            }
            if (fos_cloud_ws_connected()) {
                /* Session is up: give queued verbs a moment to arrive. */
                vTaskDelay(pdMS_TO_TICKS(3000));
            }
            keep_awake_s = keep_awake_remaining_seconds();
        }
        if (deep_sleep_now && fos_display_present() && keep_awake_s == 0) {
            /* Wake early to check the control plane for commands when asked
             * to — the render schedule itself survives in s_next_render_due
             * (RTC memory), so the check-in wake does not refresh the panel. */
            uint32_t chunk = sleep_s;
            if (config->wake_check_sec >= 60 && chunk > config->wake_check_sec) {
                chunk = config->wake_check_sec;
            }
            s_next_render_due = clock_ok ? time(NULL) + (time_t)sleep_s : 0;
            ESP_LOGI(TAG, "deep sleeping for %lu s%s%s", (unsigned long)chunk,
                     config->wake_schedule ? " (wake-on-schedule)" : "",
                     chunk < sleep_s ? " (wake-check)" : "");
            /* USB console drops in deep sleep; that's the point (battery). */
            esp_deep_sleep((uint64_t)chunk * 1000000ULL);
        }
        if (deep_sleep_now && fos_display_present() && keep_awake_s > 0) {
            ESP_LOGI(TAG, "staying awake for %lu s after HTTP activity",
                     (unsigned long)keep_awake_s);
            if (sleep_s > keep_awake_s) sleep_s = keep_awake_s;
        }
        /* Wait in 1s slices so scene-dispatched "render" events (QuickJS
         * setting the redraw flag) take effect promptly. */
        uint32_t remaining_ms = sleep_s * 1000;
        while (remaining_ms > 0) {
            uint32_t slice = remaining_ms > 1000 ? 1000 : remaining_ms;
            EventBits_t bits = xEventGroupWaitBits(s_events, RENDER_NOW_BIT, pdTRUE,
                                                   pdFALSE, pdMS_TO_TICKS(slice));
            if (bits & RENDER_NOW_BIT) {
                force_render = true;
                break;
            }
            if (config->render_mode == FOS_RENDER_LOCAL && frameos_nim_available()) {
                fos_buttons_process_events();
                /* Wall-clock schedule (setCurrentScene at 07:00 etc.) —
                 * evaluated on the render task, like every Nim call. */
                if (fos_schedule_tick()) {
                    force_render = true;
                    break;
                }
            }
            if (frameos_nim_render_requested()) {
                force_render = true;
                break;
            }
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

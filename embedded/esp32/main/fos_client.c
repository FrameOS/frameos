#include "fos_client.h"

#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

#include "esp_crt_bundle.h"
#include "esp_heap_caps.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_sleep.h"
#include "esp_timer.h"

#include "fos_battery.h"
#include "fos_buttons.h"
#include "fos_config.h"
#include "fos_scenes.h"
#include "fos_wifi.h"
#include "frameos_display.h"
#include "frameos_nim.h"

static const char *TAG = "fos_client";

#define RENDER_NOW_BIT BIT0

/* Below this charge we stop rendering and sleep long to protect the cell. */
#define FOS_BATTERY_CRITICAL_PCT 3
#define FOS_BATTERY_CRITICAL_SLEEP_SEC (6 * 3600)

/* FrameOS embedded bitmap wire format ("FOSB"):
 * magic[4] ver(u8) format(u8) width(u16le) height(u16le) reserved(u16le),
 * then the packed payload bytes for the current FOS_PIXEL_* format. */
#define FOSB_HEADER_LEN 12

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

uint32_t fos_client_render_count(void) { return s_render_count; }
int64_t fos_client_last_render_ms(void) { return s_last_render_ms; }

void fos_client_render_now(void)
{
    if (s_events) {
        xEventGroupSetBits(s_events, RENDER_NOW_BIT);
    }
}

static void store_snapshot(const uint8_t *buf, size_t len, int width, int height,
                           fos_pixel_format_t format, uint32_t render_count,
                           int64_t render_ms)
{
    if (!buf || len == 0 || width <= 0 || height <= 0 || !s_snapshot_lock) return;
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

    uint8_t *buf = heap_caps_malloc(buf_len, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!buf) buf = malloc(buf_len);
    if (!buf) {
        ESP_LOGE(TAG, "out of memory for %u byte framebuffer", (unsigned)buf_len);
        return ESP_ERR_NO_MEM;
    }
    memset(buf, 0xFF, buf_len); /* white */

    esp_err_t err;
    if (config->render_mode == FOS_RENDER_LOCAL && frameos_nim_available()) {
        err = frameos_nim_render(buf, buf_len, fos_display_format()) == 0 ? ESP_OK : ESP_FAIL;
        if (err != ESP_OK) ESP_LOGE(TAG, "nim render failed");
    } else {
        if (config->render_mode == FOS_RENDER_LOCAL) {
            ESP_LOGW(TAG, "local render requested but nim runtime unavailable; trying remote");
        }
        err = fetch_remote_bitmap(buf, buf_len);
    }

    if (err == ESP_OK && fos_display_present()) {
        err = fos_display_blit(buf, buf_len);
    } else if (err == ESP_OK) {
        ESP_LOGI(TAG, "headless: rendered %u bytes, no panel to blit", (unsigned)buf_len);
    }
    if (err == ESP_OK) {
        s_render_count++;
        s_last_render_ms = (esp_timer_get_time() - start) / 1000;
        store_snapshot(buf, buf_len, width, height, format, s_render_count, s_last_render_ms);
        ESP_LOGI(TAG, "render #%lu done in %lld ms",
                 (unsigned long)s_render_count, s_last_render_ms);
    }
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
    while (true) {
        int64_t cycle_start = esp_timer_get_time();

        /* Interpreted scenes (M3): pick up backend changes and any payload
         * pushed over HTTP/console since the last pass. Both touch the Nim
         * runtime, so they only ever run here on the render task. */
        if (config->render_mode == FOS_RENDER_LOCAL && frameos_nim_available()) {
            fos_scenes_sync(false);
            fos_scenes_apply_pending();
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
            render_once();
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
    /* Nim render + pixie + the QuickJS interpreter share this stack; QuickJS
     * is capped at 20KB (fos_qjs_glue.c), 48KB leaves room beneath it. */
    xTaskCreate(client_task, "fos_client", 49152, NULL, 5, NULL);
}

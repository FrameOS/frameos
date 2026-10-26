#include "fos_client.h"
#include "fos_heap_walk.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/time.h>
#include <time.h>

#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

#include "esp_crt_bundle.h"
#include "esp_err.h"
#include "esp_app_desc.h"
#include "esp_attr.h"
#include "esp_heap_caps.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_system.h"
#include "nvs.h"
#include "esp_sleep.h"
#include "esp_timer.h"
#include "mbedtls/sha256.h"

#include "fos_animation.h"
#include "fos_backend_http.h"
#include "fos_battery.h"
#include "fos_buttons.h"
#include "fos_gauge.h"
#include "fos_touch.h"
#include "fos_charger.h"
#include "fos_rtc.h"
#include "fos_cloud.h"
#include "fos_config.h"
#include "fos_events.h"
#include "fos_framebuffer.h"
#include "fos_http.h"
#include "fos_lan_access.h"
#include "fos_mem.h"
#include "fos_ota.h"
#include "fos_panel_draw.h"
#include "fos_power.h"
#include "fos_scenes.h"
#include "fos_scene_state.h"
#include "fos_schedule.h"
#include "fos_settings.h"
#include "fos_tz.h"
#include "fos_wake.h"
#include "fos_wifi.h"
#include "frameos_display.h"
#include "frameos_nim.h"
#include "fos_commands.h"

static const char *TAG = "fos_client";

#define RENDER_NOW_BIT BIT0
#define INPUT_EVENTS_BIT BIT1
#define COMMANDS_BIT BIT2
/* A voice session ended (fos_client_release_render): its answer goes on the
 * panel now, with the render its tools asked for when there is one. */
#define RELEASE_BIT BIT3
/* Animation mode's frame timer (fos_animation.h): the next frame is due. */
#define FRAME_DUE_BIT BIT4
/* The scene asked for a render (its render rule, after a touch or a key):
 * rendered like RENDER_NOW_BIT, but a run of them is a burst
 * (fos_animation.h), not one loud frame each. */
#define SCENE_RENDER_BIT BIT5
#define START_RENDER_LOOP_BIT BIT1
#define CLIENT_TASK_STACK_BYTES 40960

/* Below FOS_POWER_CRITICAL_MV (fos_power.h) for two passes running we stop
 * rendering and sleep this long to protect the cell. */
#define FOS_BATTERY_CRITICAL_SLEEP_SEC (6 * 3600)
/* The two ADC bursts behind one pass-start reading are this far apart; a
 * Wi-Fi TX burst that sagged the first one has moved on by the second. */
#define FOS_BATTERY_RESAMPLE_GAP_MS 60

/* How long a deep sleep waits for the cloud task to finish streaming the
 * frame's image (an `image_get` the provider queued on this pass's `render`
 * announcement, or one that waited out the sleep in the command queue). The
 * 960 KB E1004 BMP takes a few seconds; the cap is for a stalled socket. */
#define FOS_ASSET_SLEEP_HOLD_MAX_SEC 45

/* How long to hold the boot open for the provider's management socket before
 * a deep sleep, so queued commands can land (each arriving verb arms the
 * keep-awake hold and cancels this pass's sleep). */
#define FOS_CLOUD_SLEEP_GRACE_SEC 20

/* How long the first pass of a boot waits for the provider's session to
 * come up and deliver what waited out the sleep (the hub's ready frame says
 * how many verbs that is) before it renders. Observed on an E1004: the
 * session was ready 6 s after boot and the queued switch landed 3 s later,
 * by which time the previous scene was 10 s into a 34 s render that the
 * switch then threw away. Bounded for a cloud that does not answer; the
 * pass-end grace is skipped when this already waited the socket out. */
#define FOS_CLOUD_BOOT_COMMANDS_WAIT_MS 20000

/* A deep sleep must not cut an OTA short. The cloud OTA runs in its own task
 * for minutes (a 3 MB image over TLS plus flash writes), while the verb that
 * started it holds the frame awake for 15 s — so a battery frame used to
 * halt the CPU mid-download every wake, come back on the old image, be told
 * again, and repeat forever, each cycle costing a couple of minutes of
 * battery and leaving no trace but "downloading". Hold the sleep while the
 * OTA is busy, up to this long; a finished OTA reboots, a failed one clears
 * the busy flag and the sleep proceeds. */
#define FOS_OTA_SLEEP_HOLD_MAX_SEC (15 * 60)

/* How long to wait for the cloud log queue to reach the wire before the CPU
 * halts. Everything logged after the panel refresh — render:done, the
 * metrics sample with the battery reading, the sleep forecast — used to be
 * lost: the tap queues lines for the cloud task's 1 s tick, and
 * esp_deep_sleep came first. Observed on a v2026.8.40 E1004: not one battery
 * sample in 20 hours of deep-sleep cycles. */
#define FOS_SLEEP_LOG_DRAIN_MS 2500

/* When a deep-sleeping frame wakes only to check for commands
 * (wake_check_seconds), the scheduled render survives the reboot here; the
 * RTC domain keeps both this variable and the system clock through deep
 * sleep. 0 = unknown, render on the next pass. */
RTC_DATA_ATTR static time_t s_next_render_due;
/* The pass-start power decision's memory (fos_power.h): the last believed
 * cell reading and the confirmation streaks that keep one bad ADC burst
 * from switching deep sleep off or parking the frame for six hours. */
RTC_DATA_ATTR static fos_power_state_t s_power_state;

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
/* Passes that reached render_once this boot, failed or not: what
 * fos_client_render_pending() means by "the wake's render is still owed". */
static uint32_t s_render_attempts = 0;
static int64_t s_last_render_ms = 0;
static uint8_t *s_last_frame = NULL;
/* True when s_last_frame IS the boot-time framebuffer reservation (borrowed,
 * never freed here) rather than a copy this file owns. The reservation holds
 * the last packed render until someone borrows it again, so a preview costs
 * no PSRAM at all — the 8 MB E1004 could never afford the 960 KB copy and
 * shipped "hash only" snapshots, i.e. no image, on every render. */
static bool s_last_frame_borrowed = false;
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

static TaskHandle_t s_client_task = NULL;

bool fos_client_on_render_task(void)
{
    return s_client_task != NULL && xTaskGetCurrentTaskHandle() == s_client_task;
}

size_t fos_client_task_stack_free(void)
{
    return s_client_task != NULL ? (size_t)uxTaskGetStackHighWaterMark(s_client_task) : 0;
}
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

/* Why this boot happened, for the metrics sample and the wake log line: a
 * deep-sleep frame's battery story is unreadable without knowing which wakes
 * were the timer, which a button, and which a crash. */
static const char *wake_cause_name(void)
{
    switch (esp_sleep_get_wakeup_cause()) {
        case ESP_SLEEP_WAKEUP_TIMER: return "timer";
        case ESP_SLEEP_WAKEUP_EXT0:
        case ESP_SLEEP_WAKEUP_EXT1:
        case ESP_SLEEP_WAKEUP_GPIO: return "button";
        case ESP_SLEEP_WAKEUP_UNDEFINED: break;
        default: return "other";
    }
    switch (esp_reset_reason()) {
        case ESP_RST_POWERON: return "power_on";
        case ESP_RST_SW: return "restart";
        case ESP_RST_PANIC: return "panic";
        case ESP_RST_INT_WDT:
        case ESP_RST_TASK_WDT:
        case ESP_RST_WDT: return "watchdog";
        case ESP_RST_BROWNOUT: return "brownout";
        case ESP_RST_DEEPSLEEP: return "deep_sleep";
        default: return "reset";
    }
}

static void log_metrics_sample(void)
{
    char json[720];
    int battery_pct = -1, battery_mv = 0, battery_raw_mv = 0;
    if (fos_battery_present()) {
        fos_battery_read(&battery_raw_mv, &battery_pct);
        battery_mv = battery_raw_mv;
        /* Report what the pass BELIEVED, not the bare sample. fos_power.h's
         * hysteresis already refuses to act on a reading that drops
         * implausibly far in one pass, but this line went straight to the
         * ADC — so a frame that correctly kept rendering still told the
         * cloud it was at 1 %, and the graph grew a cliff that never
         * happened (E1004 reported 3062 mV at 16:38 and 3942 mV fifteen
         * minutes later, 2026-08-31). Same test, same answer, one source of
         * truth. The raw sample is still reported when the two differ, so a
         * misbehaving divider stays visible rather than being smoothed into
         * silence. */
        int believed = s_power_state.last_good_mv;
        if (believed >= FOS_POWER_PRESENT_MV &&
            battery_raw_mv < believed - FOS_POWER_GLITCH_DROP_MV) {
            battery_mv = believed;
            battery_pct = fos_battery_percent_for(believed);
        }
    }
    size_t used = (size_t)snprintf(
        json, sizeof(json),
        "{\"event\":\"metrics\",\"source\":\"esp32\","
        "\"wakeCause\":\"%s\","
        "\"uptimeSeconds\":%lld,"
        "\"freeHeapKB\":%u,\"largestHeapBlockKB\":%u,"
        "\"freeHeapMallocKB\":%u,\"largestHeapMallocBlockKB\":%u,"
        "\"freePsramKB\":%u,\"largestPsramBlockKB\":%u,"
        "\"renderStackFreeBytes\":%u,\"cloudStackFreeBytes\":%u,"
        "\"wifiRssi\":%d,\"renders\":%lu,\"renderLastMs\":%lld,"
        "\"loadedScenes\":%d,\"httpConnectRetries\":%lu",
        wake_cause_name(),
        (long long)(esp_timer_get_time() / 1000000),
        (unsigned)(heap_caps_get_free_size(MALLOC_CAP_INTERNAL) / 1024),
        /* Internal fragmentation, not just the total: TLS wants a contiguous
         * block, so a frame with 50 KB free in 4 KB pieces still cannot open
         * the cloud link. This is the number that explains such a frame. */
        (unsigned)(heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT) / 1024),
        /* The same two numbers as malloc() sees them — without the DMA
         * reserve pool that the plain INTERNAL figures above include but a
         * TLS dial cannot touch (fos_mem.h). A frame whose freeHeapKB looks
         * healthy while this pair is near zero is one dial away from
         * "connection reset by peer". */
        (unsigned)(fos_mem_internal_malloc_free() / 1024),
        (unsigned)(fos_mem_internal_malloc_largest() / 1024),
        (unsigned)(heap_caps_get_free_size(MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT) / 1024),
        (unsigned)(fos_heap_largest_free_block(MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT) / 1024),
        /* Stack high-water marks, in bytes. This sample runs on the client
         * task itself, so NULL is the render task — the 40 KB
         * CLIENT_TASK_STACK_BYTES that internal RAM pays for whether the
         * renderer ever needed it or not. */
        (unsigned)uxTaskGetStackHighWaterMark(NULL),
        (unsigned)fos_cloud_task_stack_free(),
        fos_wifi_rssi(), (unsigned long)s_render_count, s_last_render_ms,
        fos_scenes_loaded(),
        (unsigned long)(fos_http_connect_retries() + fos_nim_http_connect_retries()));
    /* The charger's word, where the board has one: USB in or not, charging
     * or not. It also decides onBattery below, as it does the deep sleep. */
    fos_charger_status_t charger;
    bool charger_known = fos_charger_present() && fos_charger_read(&charger) == ESP_OK;
    /* Or the fuel gauge's (the Sticky, fos_gauge.c): current flowing in is
     * an input, discharging is the cell on its own. */
    fos_gauge_status_t gauge;
    if (!charger_known && fos_gauge_present() && fos_gauge_read(&gauge) == ESP_OK && gauge.present) {
        memset(&charger, 0, sizeof(charger));
        charger.usb_power = !gauge.discharging;
        charger.charging = gauge.charging;
        charger.charge_done = gauge.full;
        charger_known = true;
    }
    if (battery_pct >= 0 && used < sizeof(json) - 128) {
        /* onBattery is the same test the deep-sleep decision uses — the
         * charger's "no input", or without one, "a cell is present" — so a
         * provider can tell whether deep_sleep_on_battery is in force right
         * now instead of guessing from the percentage. */
        bool on_battery = charger_known ? !charger.usb_power : battery_mv >= FOS_POWER_PRESENT_MV;
        used += (size_t)snprintf(json + used, sizeof(json) - used,
                                 ",\"batteryPercent\":%d,\"batteryMillivolts\":%d,\"onBattery\":%s",
                                 battery_pct, battery_mv, on_battery ? "true" : "false");
        if (battery_raw_mv != battery_mv && used < sizeof(json) - 40) {
            used += (size_t)snprintf(json + used, sizeof(json) - used,
                                     ",\"batteryRawMillivolts\":%d", battery_raw_mv);
        }
    }
    if (charger_known && used < sizeof(json) - 48) {
        used += (size_t)snprintf(json + used, sizeof(json) - used, ",\"usbPower\":%s,\"charging\":%s",
                                 charger.usb_power ? "true" : "false", charger.charging ? "true" : "false");
    }
    uint32_t wifi_drops = 0, wifi_down_ms = 0;
    uint8_t wifi_drop_reason = 0;
    fos_wifi_drop_stats(&wifi_drops, &wifi_drop_reason, &wifi_down_ms);
    if (wifi_drops > 0 && used < sizeof(json) - 80) {
        /* Only when the link went away this boot: the reason is the 802.11
         * code (WIFI_REASON_*: 200 beacon timeout, 2/4 the AP expired us,
         * 15 a key handshake timed out), which tells a bad signal from an
         * access point that dropped the frame. */
        used += (size_t)snprintf(json + used, sizeof(json) - used,
                                 ",\"wifiDrops\":%lu,\"wifiDropReason\":%u,\"wifiDownMs\":%lu",
                                 (unsigned long)wifi_drops, (unsigned)wifi_drop_reason,
                                 (unsigned long)wifi_down_ms);
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

double fos_client_metrics_newest_timestamp(void)
{
    if (s_metrics_lock == NULL) return 0;
    xSemaphoreTake(s_metrics_lock, portMAX_DELAY);
    double ts = 0;
    if (s_metrics_count > 0) {
        size_t newest = (s_metrics_next + FOS_METRICS_RING_CAP - 1) % FOS_METRICS_RING_CAP;
        ts = s_metrics_ring[newest].timestamp;
    }
    xSemaphoreGive(s_metrics_lock);
    return ts;
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

/* The stored hash is an e-paper fact: the glass keeps the picture through
 * a reboot or a deep sleep, so an unchanged render need not refresh it. An
 * LCD comes up blank (white) at every boot — a stored hash would skip the
 * first render's blit and leave it white — and writing the hash after every
 * render is a flash write, which holds off the LCD's scan-out refill (the
 * cache is off) for a visibly jumped frame (the SenseCAP Indicator,
 * 2026-10-25). So on an LCD the hash lives in RAM only: an unchanged render
 * within one boot still skips its copy. */
static bool display_state_persists(void)
{
    return !fos_display_is_lcd();
}

static void load_display_state(void)
{
    if (s_display_state_loaded) return;
    s_display_state_loaded = true;
    s_display_state_valid = false;
    if (!display_state_persists()) return;
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
    if (!display_state_persists()) return;
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
    size_t largest_psram = fos_heap_largest_free_block(MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    return largest_psram >= len && free_psram >= len + FOS_SNAPSHOT_MIN_PSRAM_AFTER_COPY;
}

void fos_client_render_now(void)
{
    if (s_events) {
        xEventGroupSetBits(s_events, RENDER_NOW_BIT);
    }
}

/* Set by any task, taken by the render task right before it renders. */
static bool s_render_fresh = false;

void fos_client_render_fresh(void)
{
    __atomic_store_n(&s_render_fresh, true, __ATOMIC_SEQ_CST);
    fos_client_render_now();
}

void fos_client_render_for_scene(void)
{
    if (s_events) {
        xEventGroupSetBits(s_events, SCENE_RENDER_BIT);
    }
}

void fos_client_wake_for_events(void)
{
    if (s_events) {
        xEventGroupSetBits(s_events, INPUT_EVENTS_BIT);
    }
}

/* The input queues, then time passing, in that order: the buttons' edges and
 * the glass's reports reach the dispatcher before a tick asks what is still
 * held. A release waiting in the touch queue behind the render its press
 * caused would otherwise be a finger held all along: a tap read as a long
 * press. The render task's, like every Nim call. */
static void process_input_events(void)
{
    fos_buttons_process_events();
    fos_touch_process_events();
    if (frameos_nim_tick()) {
        fos_client_wake_for_events();
    }
}

void fos_client_request_commands_sync(void)
{
    if (s_events) {
        xEventGroupSetBits(s_events, COMMANDS_BIT);
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
    /* A local network access code on the panel holds the deep sleep until it is
     * answered or expires: the person walking to the frame to read it must
     * find the code there, and its end must repaint the panel. Not a
     * keep_awake_ms() window, which an answered code could not shorten. */
    uint32_t lan_s = fos_lan_access_seconds_left(fos_lan_access_now());
    uint32_t hold_s = 0;
    if (until_us > now_us) hold_s = (uint32_t)((until_us - now_us + 999999) / 1000000);
    return lan_s > hold_s ? lan_s : hold_s;
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
/* True from the moment a pass decides to render until render_once returns
 * (image fetches, the scene, dither, the panel refresh). Read by fos_ota.c:
 * an OTA that starts next to a render shares one Wi-Fi link and ~80 KB of
 * internal heap with a TLS image stream — E1004 2026-10-12 died at 1 MB of
 * 3.2 MB that way — so the download waits for the pass to finish first. */
static volatile bool s_render_in_flight = false;

bool fos_client_render_in_flight(void)
{
    return s_render_in_flight;
}

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

/* Drop a borrowed snapshot before its buffer is lent out again (the next
 * render, a console display_test, the status screen): whoever borrows the
 * reservation is about to overwrite it. Runs on the borrower's task from
 * fos_framebuffer_acquire; a preview stream holding the lock finishes first
 * (bounded — a stalled socket must not stall the panel). */
static void snapshot_before_lend(void)
{
    if (!s_snapshot_lock) return;
    if (xSemaphoreTake(s_snapshot_lock, pdMS_TO_TICKS(30000)) != pdTRUE) {
        ESP_LOGW(TAG, "preview snapshot still streaming after 30 s; rendering over it");
        return;
    }
    if (s_last_frame_borrowed) {
        s_last_frame = NULL;
        s_last_frame_len = 0;
        s_last_frame_borrowed = false;
    }
    xSemaphoreGive(s_snapshot_lock);
}

/* An LCD frame buffer that is about to be drawn in (fos_display_render_target,
 * a copy into it, a clear): a snapshot pointing at it lets go first. A
 * stream holds the lock only while it copies the snapshot out
 * (fos_http_preview_bmp_stream), so this waits milliseconds at most. */
static void snapshot_before_panel_write(const uint8_t *buf)
{
    if (!s_snapshot_lock || !buf) return;
    if (xSemaphoreTake(s_snapshot_lock, pdMS_TO_TICKS(30000)) != pdTRUE) {
        ESP_LOGW(TAG, "preview snapshot still held after 30 s; drawing over it");
        return;
    }
    if (s_last_frame_borrowed && s_last_frame == buf) {
        s_last_frame = NULL;
        s_last_frame_len = 0;
        s_last_frame_borrowed = false;
    }
    xSemaphoreGive(s_snapshot_lock);
}

/* `borrow`: `buf` is an LCD frame buffer just shown, which stays as it is
 * until it is drawn in again (snapshot_before_panel_write lets go then). */
static void store_snapshot(const uint8_t *buf, size_t len, int width, int height,
                           fos_pixel_format_t format, uint32_t render_count,
                           int64_t render_ms, bool borrow)
{
    if (!buf || len == 0 || width <= 0 || height <= 0 || !s_snapshot_lock) return;
    if (borrow || fos_framebuffer_is_reserved(buf)) {
        /* The packed bytes stay put in the reservation (or the panel's
         * buffer) until the next borrower; point at them instead of
         * copying. */
        xSemaphoreTake(s_snapshot_lock, portMAX_DELAY);
        uint8_t *old = s_last_frame_borrowed ? NULL : s_last_frame;
        s_last_frame = (uint8_t *)buf;
        s_last_frame_borrowed = true;
        s_last_frame_len = len;
        s_last_frame_width = width;
        s_last_frame_height = height;
        s_last_frame_format = format;
        s_last_frame_render_count = render_count;
        s_last_frame_render_ms = render_ms;
        xSemaphoreGive(s_snapshot_lock);
        free(old);
        return;
    }
    if (!should_keep_packed_snapshot(len)) {
        xSemaphoreTake(s_snapshot_lock, portMAX_DELAY);
        uint8_t *old = s_last_frame_borrowed ? NULL : s_last_frame;
        s_last_frame = NULL;
        s_last_frame_borrowed = false;
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
    uint8_t *old = s_last_frame_borrowed ? NULL : s_last_frame;
    s_last_frame = copy;
    s_last_frame_borrowed = false;
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

bool fos_client_snapshot_acquire(uint32_t timeout_ms, const uint8_t **buf, int *width,
                                 int *height, fos_pixel_format_t *format, size_t *len)
{
    if (!buf || !s_snapshot_lock) return false;
    if (xSemaphoreTake(s_snapshot_lock, pdMS_TO_TICKS(timeout_ms)) != pdTRUE) return false;
    if (!s_last_frame || s_last_frame_len == 0) {
        xSemaphoreGive(s_snapshot_lock);
        return false;
    }
    *buf = s_last_frame;
    if (width) *width = s_last_frame_width;
    if (height) *height = s_last_frame_height;
    if (format) *format = s_last_frame_format;
    if (len) *len = s_last_frame_len;
    return true; /* lock held until fos_client_snapshot_release */
}

void fos_client_snapshot_release(void)
{
    if (s_snapshot_lock) xSemaphoreGive(s_snapshot_lock);
}

bool fos_client_render_pending(void)
{
    /* The first pass of a boot has not run its render yet (a deep-sleep wake
     * renders before it does anything else), or the loop was told to render
     * now. A render that failed counts as run: nothing is coming. */
    if (s_render_attempts == 0 && !s_render_paused_for_memory) return true;
    return s_events && (xEventGroupGetBits(s_events) & RENDER_NOW_BIT) != 0;
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

/* ------------------------------------------------------------ image push */

/* A self-hosted backend pulls GET /image only while it can find and reach
 * the frame awake, which a deep-sleeping battery frame, a `.local` name
 * (there is no mDNS) or a NAT in between all defeat. The frame reaches the
 * backend fine (logs, scenes, settings), so after a render it hands over the
 * image itself: the BMP the preview routes serve, streamed from the packed
 * snapshot. The cloud gets the same image over its socket (image_get). */
#define FOS_IMAGE_PUSH_TIMEOUT_MS 10000
#define FOS_IMAGE_PUSH_CHUNK 4096
/* A fast LCD or OLED scene renders every second; e-paper never gets close. */
#define FOS_IMAGE_PUSH_MIN_INTERVAL_US (10LL * 1000000LL)

/* The panel image the backend last accepted, kept across deep sleeps: an
 * unchanged panel is not sent again, and a failed push is retried after the
 * next render even when the panel did not change. */
RTC_DATA_ATTR static uint8_t s_pushed_image_sha[FOS_DISPLAY_HASH_LEN];
RTC_DATA_ATTR static bool s_pushed_image_valid;
static int64_t s_last_image_push_us = 0;

typedef struct {
    esp_http_client_handle_t client;
    size_t used;
    bool failed;
    uint8_t buf[FOS_IMAGE_PUSH_CHUNK];
} image_push_t;

static bool image_push_flush(image_push_t *push)
{
    size_t sent = 0;
    while (sent < push->used) {
        int w = esp_http_client_write(push->client, (const char *)push->buf + sent,
                                      (int)(push->used - sent));
        if (w <= 0) {
            push->failed = true;
            return false;
        }
        sent += (size_t)w;
    }
    push->used = 0;
    return true;
}

static void image_push_begin(void *ctx, size_t total)
{
    image_push_t *push = (image_push_t *)ctx;
    if (esp_http_client_open(push->client, (int)total) != ESP_OK) push->failed = true;
}

/* The stream writes one panel row at a time; batch them so a TLS record is
 * not spent on every 600 bytes. */
static bool image_push_write(void *ctx, const uint8_t *data, size_t len)
{
    image_push_t *push = (image_push_t *)ctx;
    while (len > 0 && !push->failed) {
        size_t take = sizeof(push->buf) - push->used;
        if (take > len) take = len;
        memcpy(push->buf + push->used, data, take);
        push->used += take;
        data += take;
        len -= take;
        if (push->used == sizeof(push->buf)) image_push_flush(push);
    }
    return !push->failed;
}

static void url_query_escape(const char *src, char *out, size_t out_len)
{
    static const char hex[] = "0123456789ABCDEF";
    size_t used = 0;
    for (; src && *src && used + 4 < out_len; src++) {
        unsigned char c = (unsigned char)*src;
        if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
            c == '-' || c == '_' || c == '.' || c == '~') {
            out[used++] = (char)c;
        } else {
            out[used++] = '%';
            out[used++] = hex[c >> 4];
            out[used++] = hex[c & 0x0F];
        }
    }
    out[used] = '\0';
}

/* The hash of the stored snapshot: what an LCD, which keeps no per-render
 * hash (render_once), pushes and compares by. */
static bool snapshot_display_state(fos_display_state_t *state)
{
    if (!s_snapshot_lock) return false;
    xSemaphoreTake(s_snapshot_lock, portMAX_DELAY);
    bool ok = s_last_frame && s_last_frame_len > 0 &&
              display_state_for_buffer(s_last_frame, s_last_frame_len, s_last_frame_width,
                                       s_last_frame_height, s_last_frame_format, state);
    xSemaphoreGive(s_snapshot_lock);
    return ok;
}

static void push_image_to_backend(const char *scene_id)
{
    fos_config_t *config = fos_config();
    if (!config->backend_url[0] || config->frame_id == 0 || !config->api_key[0]) return;
    if (!fos_display_present()) return;
    bool lcd = fos_display_is_lcd();
    if (!lcd && !s_display_state_valid) return;
    if (!lcd && s_pushed_image_valid &&
        memcmp(s_pushed_image_sha, s_display_state.sha256, FOS_DISPLAY_HASH_LEN) == 0) {
        return;
    }
    if (fos_wifi_state() != FOS_WIFI_CONNECTED) return;
    int64_t now_us = esp_timer_get_time();
    if (s_last_image_push_us != 0 && now_us - s_last_image_push_us < FOS_IMAGE_PUSH_MIN_INTERVAL_US) {
        return;
    }
    /* No retained snapshot (a hash-only board): nothing to send. */
    if (!fos_client_snapshot_info(NULL, NULL, NULL, NULL, NULL, NULL)) return;
    fos_display_state_t pushed = s_display_state;
    if (lcd) {
        /* Hashed here, at most once per push interval, instead of per frame. */
        if (!snapshot_display_state(&pushed)) return;
        if (s_pushed_image_valid && memcmp(s_pushed_image_sha, pushed.sha256, FOS_DISPLAY_HASH_LEN) == 0) {
            return;
        }
    }
    s_last_image_push_us = now_us;

    char scene_q[3 * 128 + 1];
    url_query_escape(scene_id, scene_q, sizeof(scene_q));
    char url[FOS_URL_LEN + sizeof(scene_q) + 64];
    snprintf(url, sizeof(url), "%s/api/frames/%lu/embedded/image%s%s", config->backend_url,
             (unsigned long)config->frame_id, scene_q[0] ? "?scene_id=" : "", scene_q);
    char auth[FOS_STR_LEN + 16];
    snprintf(auth, sizeof(auth), "Bearer %s", config->api_key);

    image_push_t *push = calloc(1, sizeof(*push));
    if (!push) return;
    esp_http_client_config_t http_config = {
        .url = url,
        .method = HTTP_METHOD_POST,
        .timeout_ms = FOS_IMAGE_PUSH_TIMEOUT_MS,
        .crt_bundle_attach = esp_crt_bundle_attach,
        .buffer_size = 1024,
    };
    push->client = esp_http_client_init(&http_config);
    if (!push->client) {
        free(push);
        return;
    }
    esp_http_client_set_header(push->client, "Authorization", auth);
    esp_http_client_set_header(push->client, "Content-Type", "image/bmp");

    static const fos_preview_sink_t sink = {
        .begin = image_push_begin,
        .write = image_push_write,
    };
    esp_err_t err = fos_http_preview_bmp_stream(&sink, push, 5000, NULL, 0);
    if (err == ESP_OK && !image_push_flush(push)) err = ESP_FAIL;
    int status = 0;
    if (err == ESP_OK && !push->failed) {
        esp_http_client_fetch_headers(push->client);
        status = esp_http_client_get_status_code(push->client);
    }
    esp_http_client_close(push->client);
    esp_http_client_cleanup(push->client);
    free(push);

    int64_t ms = (esp_timer_get_time() - now_us) / 1000;
    if (status == 200) {
        memcpy(s_pushed_image_sha, pushed.sha256, FOS_DISPLAY_HASH_LEN);
        s_pushed_image_valid = true;
        ESP_LOGI(TAG, "image pushed to the backend in %lld ms", ms);
    } else {
        ESP_LOGW(TAG, "image push to the backend failed (%s, HTTP %d, %lld ms)",
                 esp_err_to_name(err), status, ms);
    }
}

/* ------------------------------------------------------------- the loop */

/* The facts behind the built-in status screen (frameos/utils/status_screen
 * via embedded_scene.nim), pushed into the Nim runtime before a pass that
 * has no scene to draw. Same rows as a Pi's boot screen / system/index:
 * name, panel, network, who manages the frame, version. */
static void push_status_info(void)
{
    fos_config_t *config = fos_config();
    char name[2 * FOS_STR_LEN];
    char panel[2 * FOS_STR_LEN];
    char ssid[96];
    char cloud_url[2 * FOS_URL_LEN];
    char backend_url[2 * FOS_URL_LEN];
    json_escape_value(config->hostname, name, sizeof(name));
    json_escape_value(config->panel, panel, sizeof(panel));
    bool portal = fos_wifi_state() == FOS_WIFI_PORTAL;
    json_escape_value(portal ? fos_wifi_ap_ssid() : "", ssid, sizeof(ssid));
    json_escape_value(config->cloud_url, cloud_url, sizeof(cloud_url));
    json_escape_value(config->backend_url, backend_url, sizeof(backend_url));
    const esp_app_desc_t *app = esp_app_get_description();

    /* Worst case of every %s below plus the fixed JSON: gcc's
     * -Wformat-truncation wants the destination to hold it outright. */
    char info[sizeof(name) + sizeof(panel) + sizeof(ssid) + sizeof(cloud_url) + sizeof(backend_url) +
              4 * 64 + 256];
    snprintf(info, sizeof(info),
             "{\"name\":\"%s\",\"panel\":\"%s\",\"ip\":\"%s\","
             "\"portal\":%s,\"portal_ssid\":\"%s\",\"portal_ip\":\"%s\","
             "\"cloud_url\":\"%s\",\"cloud_state\":\"%s\",\"cloud_connected\":%s,"
             "\"backend_url\":\"%s\",\"version\":\"%s\"}",
             name, panel, portal ? "" : fos_wifi_ip(),
             portal ? "true" : "false", ssid, portal ? fos_wifi_ip() : "",
             cloud_url, fos_cloud_state_name(), fos_cloud_ws_connected() ? "true" : "false",
             backend_url, app ? app->version : "");
    frameos_nim_set_status_info(info);
}

/* ------------------------------------------------- the local network access code */

/* The generation of the local network access code (fos_lan_access.h) the render task
 * last answered: drew, or saw end. Render task only. */
static uint32_t s_lan_seen_gen = 0;

/* A code appeared, was replaced or ended since the last render looked: one
 * render, so the panel shows it or loses it. One per change — a render that
 * then fails or is skipped (battery, OTA) does not make this fire again. */
static bool lan_access_panel_changed(void)
{
    if (!fos_display_present()) return false;
    uint32_t generation = fos_lan_access_panel_code(fos_lan_access_now(), NULL);
    if (generation == s_lan_seen_gen) return false;
    s_lan_seen_gen = generation;
    return true;
}

typedef struct {
    bool drawn;
    fos_panel_surface_t surface;
    fos_panel_code_box_t box;
    uint8_t *saved; /* the render under the box; NULL = paint it white */
} lan_overlay_t;

/* Draw the pending code over a finished render, for the panel only
 * (docs/lan-access.md). Between this and lan_overlay_end() the buffer holds
 * the code, and nothing that reads it as an image may run: the snapshot
 * behind /image, image_get and the backend push is stored after the end. */
static void lan_overlay_begin(lan_overlay_t *ov, uint8_t *buf, int width, int height,
                              fos_pixel_format_t format)
{
    memset(ov, 0, sizeof(*ov));
    char code[FOS_LAN_ACCESS_CODE_LEN + 1];
    uint32_t generation = fos_lan_access_panel_code(fos_lan_access_now(), code);
    s_lan_seen_gen = generation;
    if (generation == 0) return;
    if (s_last_frame == buf) {
        /* The lend hook could not drop the preview snapshot (a stream stalled
         * past 30 s) so this buffer is still served as the frame's image. */
        ESP_LOGW(TAG, "Local network access code skipped: buffer still lent");
    } else {
        ov->surface = (fos_panel_surface_t){
            .buf = buf, .width = width, .height = height, .format = format,
            .rotate = fos_config()->rotate,
        };
        if (fos_panel_code_box(&ov->surface, "Local network access code", FOS_LAN_ACCESS_CODE_LEN,
                               &ov->box)) {
            size_t bytes = fos_panel_box_copy(&ov->surface, &ov->box, NULL, false);
            ov->saved = bytes ? fos_big_malloc(bytes) : NULL;
            if (ov->saved) fos_panel_box_copy(&ov->surface, &ov->box, ov->saved, false);
            fos_panel_draw_code(&ov->surface, &ov->box, "Local network access code", code);
            ov->drawn = true;
            frameos_nim_log_hook("{\"event\":\"lan_access:shown\",\"source\":\"esp32\"}");
        }
    }
    volatile char *wipe = code;
    for (size_t i = 0; i < sizeof(code); i++) wipe[i] = 0;
}

static void lan_overlay_end(lan_overlay_t *ov)
{
    if (!ov->drawn) return;
    if (ov->saved) {
        fos_panel_box_copy(&ov->surface, &ov->box, ov->saved, true);
    } else {
        /* No memory for a copy: a white box, still never the code. */
        fos_panel_fill_rect(&ov->surface, ov->box.x, ov->box.y, ov->box.w, ov->box.h, false);
    }
    free(ov->saved);
    ov->saved = NULL;
    ov->drawn = false;
}

/* ------------------------------------------------------------- the notice */

/* The voice chat's answer (fos_voice.c), for the panel (docs/voice-chat.md).
 * Written by any task under s_notice_lock, read by the render task. */
#define NOTICE_TEXT_LEN 640
static portMUX_TYPE s_notice_lock = portMUX_INITIALIZER_UNLOCKED;
static char s_notice_text[NOTICE_TEXT_LEN];
static volatile bool s_notice_pending = false;
/* The hold (fos_client_hold_render): no render starts while it is on. The
 * chat's tools arrive one by one — a scene switch, then the state for the
 * new scene — and the first used to start a 45 s render on the E1002 that
 * the second then waited out, so the answer went on the panel in two
 * refreshes, the first with the old text. Deadline 0 = no hold. */
static int64_t s_render_hold_until_us = 0;
/* A render asked for during the hold, for the release. Render task only. */
static bool s_render_owed = false;
/* A notice is on the panel since this moment (0 = none): it comes off after
 * NOTICE_SHOWN_MS, or with the next render if that is sooner — the next
 * render used to be the scene's own interval, an hour for a photo scene,
 * and the answer sat there all that time. Render task only. */
#define NOTICE_SHOWN_MS 30000
static int64_t s_notice_shown_us = 0;

void fos_client_show_notice(const char *text)
{
    if (!text || !text[0]) return;
    portENTER_CRITICAL(&s_notice_lock);
    strlcpy(s_notice_text, text, sizeof(s_notice_text));
    s_notice_pending = true;
    portEXIT_CRITICAL(&s_notice_lock);
    fos_client_keep_awake_ms(60000);
}

void fos_client_hold_render(uint32_t ms)
{
    int64_t until_us = esp_timer_get_time() + (int64_t)ms * 1000;
    portENTER_CRITICAL(&s_notice_lock);
    s_render_hold_until_us = until_us;
    portEXIT_CRITICAL(&s_notice_lock);
}

void fos_client_release_render(void)
{
    portENTER_CRITICAL(&s_notice_lock);
    s_render_hold_until_us = 0;
    portEXIT_CRITICAL(&s_notice_lock);
    if (s_events) xEventGroupSetBits(s_events, RELEASE_BIT);
}

static bool render_held(void)
{
    int64_t until_us;
    portENTER_CRITICAL(&s_notice_lock);
    until_us = s_render_hold_until_us;
    portEXIT_CRITICAL(&s_notice_lock);
    return until_us != 0 && esp_timer_get_time() < until_us;
}

typedef struct {
    bool drawn;
    fos_panel_surface_t surface;
    fos_panel_code_box_t box;
    uint8_t *saved;
} notice_overlay_t;

/* Draw the pending notice over a finished render, for the panel only, like
 * the code box: restored before anything reads the buffer as an image. */
static void notice_overlay_begin(notice_overlay_t *ov, uint8_t *buf, int width, int height,
                                 fos_pixel_format_t format)
{
    memset(ov, 0, sizeof(*ov));
    if (!s_notice_pending) return;
    char text[NOTICE_TEXT_LEN];
    portENTER_CRITICAL(&s_notice_lock);
    strlcpy(text, s_notice_text, sizeof(text));
    s_notice_pending = false;
    portEXIT_CRITICAL(&s_notice_lock);
    if (s_last_frame == buf) return; /* see lan_overlay_begin */
    ov->surface = (fos_panel_surface_t){
        .buf = buf, .width = width, .height = height, .format = format,
        .rotate = fos_config()->rotate,
    };
    /* Glyphs 3 px per font pixel on a big panel (an 800 px line takes ~44
     * characters), smaller where the text would not fit in six lines. */
    if (!fos_panel_notice_box(&ov->surface, text, width >= 600 ? 3 : 2, 6, &ov->box)) return;
    size_t bytes = fos_panel_box_copy(&ov->surface, &ov->box, NULL, false);
    ov->saved = bytes ? fos_big_malloc(bytes) : NULL;
    if (ov->saved) fos_panel_box_copy(&ov->surface, &ov->box, ov->saved, false);
    fos_panel_draw_notice(&ov->surface, &ov->box, text);
    ov->drawn = true;
    s_notice_shown_us = esp_timer_get_time();
    /* The bench's proof that the panel got it: the snapshot never does. */
    frameos_nim_log_hook("{\"event\":\"voice:shown\",\"source\":\"esp32\"}");
}

static void notice_overlay_end(notice_overlay_t *ov)
{
    if (!ov->drawn) return;
    if (ov->saved) {
        fos_panel_box_copy(&ov->surface, &ov->box, ov->saved, true);
    } else {
        fos_panel_fill_rect(&ov->surface, ov->box.x, ov->box.y, ov->box.w, ov->box.h, false);
    }
    free(ov->saved);
    ov->saved = NULL;
    ov->drawn = false;
}

/* The panel shows something no stored hash describes (the render plus a
 * code): the next render must refresh even when the scene did not change,
 * here and after a reboot. */
static void forget_display_state(void)
{
    s_display_state_loaded = true;
    s_display_state_valid = false;
    if (!display_state_persists()) return;
    nvs_handle_t nvs;
    if (nvs_open("frameos", NVS_READWRITE, &nvs) != ESP_OK) return;
    if (nvs_erase_key(nvs, "display_state") == ESP_OK) nvs_commit(nvs);
    nvs_close(nvs);
}

/* The last image again, on a copy of the stored snapshot — no scene render,
 * so a photo scene keeps its photo and the panel refreshes once. With the
 * pending notice over it (an answer that changed nothing), or plain (the
 * notice's time is up: the snapshot never carried it). Render task. False
 * when there is no stored image (kept as a hash only when PSRAM was short)
 * or no copy fits: the caller renders instead. */
static bool repaint_snapshot(bool with_notice)
{
    if ((with_notice && !s_notice_pending) || !fos_display_present() || !s_snapshot_lock) return false;
    xSemaphoreTake(s_snapshot_lock, portMAX_DELAY);
    size_t len = s_last_frame ? s_last_frame_len : 0;
    int width = s_last_frame_width, height = s_last_frame_height;
    fos_pixel_format_t format = s_last_frame_format;
    uint8_t *copy = len ? fos_big_malloc(len) : NULL;
    if (copy) memcpy(copy, s_last_frame, len);
    xSemaphoreGive(s_snapshot_lock);
    if (!copy) return false;
    notice_overlay_t notice = {0};
    if (with_notice) {
        notice_overlay_begin(&notice, copy, width, height, format);
        if (!notice.drawn) {
            free(copy);
            return false;
        }
        ESP_LOGI(TAG, "repainting the last image with the notice");
        fos_display_blit(copy, len);
        s_last_refresh_skipped = false;
        forget_display_state();
        notice_overlay_end(&notice);
    } else {
        ESP_LOGI(TAG, "repainting the last image without the notice");
        esp_err_t err = fos_display_blit(copy, len);
        s_last_refresh_skipped = false;
        /* The panel shows exactly the snapshot again: its hash is good for
         * the "unchanged, skip the refresh" check once more. */
        fos_display_state_t state;
        if (err == ESP_OK && display_state_for_buffer(copy, len, width, height, format, &state)) {
            s_display_state = state;
            s_display_state_valid = true;
            save_display_state(&state);
        }
        s_notice_shown_us = 0;
    }
    free(copy);
    return true;
}

/* The notice has been on the panel long enough. Render task. */
static bool notice_expired(void)
{
    return s_notice_shown_us != 0 && fos_display_present() &&
           esp_timer_get_time() - s_notice_shown_us >= (int64_t)NOTICE_SHOWN_MS * 1000;
}

static bool panel_overlay_pending(void)
{
    return fos_lan_access_panel_code(fos_lan_access_now(), NULL) != 0 || s_notice_pending;
}

/* An overlay drawn into an LCD buffer that the panel now shows: it stays on
 * the glass until the next frame, and the snapshot was copied before it went
 * on, so there is nothing to put back. */
static void lan_overlay_forget(lan_overlay_t *ov)
{
    free(ov->saved);
    ov->saved = NULL;
    ov->drawn = false;
}

static void notice_overlay_forget(notice_overlay_t *ov)
{
    free(ov->saved);
    ov->saved = NULL;
    ov->drawn = false;
}

/* `quiet`: an animation's in-between frame (fos_animation.h) — none of the
 * render:* lines, no render announce, no backend push. */
static esp_err_t render_once(bool quiet)
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
    if (quiet) {
        scene_id[0] = '\0';
        scene_name[0] = '\0';
    } else {
        current_scene_details(scene_id, sizeof(scene_id), scene_name, sizeof(scene_name));
        log_render_event("render:scene", scene_id, scene_name, "rendering", "start",
                         mode, fos_display_present() ? "pending" : "none", "",
                         render_attempt, 0, width, height, format, buf_len, ESP_OK);
        frameos_nim_flush_logs();
    }

    uint8_t *buf = NULL;
    esp_err_t err;
    /* An LCD's back frame buffer, drawn in place: no pack, no copy, and the
     * blit below is a buffer switch (fos_display_render_target). */
    bool in_panel = false;
    if (local_render) {
        if (fos_scenes_loaded() == 0) {
            push_status_info();
        }
        /* Somebody asked for this render: every scene inside the current
         * one runs, also those not yet due (frameos/scene_rhythm.nim). */
        if (__atomic_exchange_n(&s_render_fresh, false, __ATOMIC_SEQ_CST)) {
            frameos_nim_request_fresh_pass();
        }
        size_t target_len = 0;
        uint32_t generation = 0;
        uint8_t *target = fos_display_present() ? fos_display_render_target(&target_len, &generation) : NULL;
        if (target && target_len == buf_len) {
            buf = target;
            in_panel = true;
            err = frameos_nim_render_panel(buf, buf_len, format, generation) == 0 ? ESP_OK : ESP_FAIL;
        } else {
            if (target) fos_display_release_render_target();
            err = frameos_nim_render_alloc(&buf, &buf_len, fos_display_format()) == 0 ? ESP_OK : ESP_FAIL;
        }
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
    if (!quiet) {
        log_render_event("render:framebuffer", scene_id, scene_name,
                         err == ESP_OK ? "rendered" : "error", "framebuffer",
                         mode, fos_display_present() ? "pending" : "none",
                         err == ESP_OK ? "" : "render-failed", render_attempt,
                         framebuffer_ms, width, height, format, buf_len, err);
        frameos_nim_flush_logs();
    }

    /* The hash is an e-paper fact: an unchanged picture skips a refresh that
     * takes seconds. An LCD shows a frame by switching a buffer, so there is
     * nothing to skip, and hashing 460 KB cost a frame of its own; the
     * backend push hashes what it sends (push_image_to_backend). */
    fos_display_state_t rendered_state;
    bool rendered_state_valid = err == ESP_OK && fos_display_present() && !fos_display_is_lcd() &&
        display_state_for_buffer(buf, buf_len, width, height, format, &rendered_state);
    bool skipped_refresh = false;
    bool snapshot_stored = false;
    const char *refresh = fos_display_present() ? "pending" : "none";
    /* After the hash (which describes the render, not the code) and only for
     * the panel: see lan_overlay_begin. Drawn in place, the buffer is what
     * the panel shows next and keeps the overlay: the snapshot is a copy
     * taken before it goes on. */
    lan_overlay_t lan_overlay = {0};
    notice_overlay_t notice = {0};
    if (err == ESP_OK && fos_display_present()) {
        if (in_panel && panel_overlay_pending()) {
            store_snapshot(buf, buf_len, width, height, format, s_render_count + 1,
                           (esp_timer_get_time() - start) / 1000, false);
            snapshot_stored = true;
        }
        lan_overlay_begin(&lan_overlay, buf, width, height, format);
        notice_overlay_begin(&notice, buf, width, height, format);
        /* Drawn into the buffer the panel shows: the next render in place
         * there must not take it for its own frame. */
        if (in_panel && (lan_overlay.drawn || notice.drawn)) fos_display_mark_written(buf);
    }
    bool overlay_drawn = lan_overlay.drawn || notice.drawn;
    if (err == ESP_OK && fos_display_present()) {
        load_display_state();
        if (!overlay_drawn && rendered_state_valid && s_display_state_valid &&
            display_state_matches(&rendered_state, &s_display_state)) {
            skipped_refresh = true;
            s_last_refresh_skipped = true;
            refresh = "skipped";
            char sha_hex[FOS_DISPLAY_HASH_LEN * 2 + 1];
            sha256_hex(rendered_state.sha256, sha_hex);
            ESP_LOGI(TAG, "display refresh skipped: packed image unchanged (%.*s)", 12, sha_hex);
            if (!quiet) {
                log_render_event("render:device", scene_id, scene_name, "skipped",
                                 "display", mode, refresh, "unchanged",
                                 render_attempt, (esp_timer_get_time() - start) / 1000,
                                 width, height, format, buf_len, ESP_OK);
                frameos_nim_flush_logs();
            }
        } else {
            refresh = "update";
            if (!quiet) {
                log_render_event("render:device", scene_id, scene_name, "refreshing",
                                 "display", mode, refresh, "", render_attempt,
                                 (esp_timer_get_time() - start) / 1000, width, height,
                                 format, buf_len, ESP_OK);
                frameos_nim_flush_logs();
            }
            err = fos_display_blit(buf, buf_len);
            refresh = err == ESP_OK ? "updated" : "failed";
            if (overlay_drawn) {
                if (in_panel) {
                    lan_overlay_forget(&lan_overlay);
                    notice_overlay_forget(&notice);
                } else {
                    lan_overlay_end(&lan_overlay);
                    notice_overlay_end(&notice);
                }
                s_last_refresh_skipped = false;
                forget_display_state();
            } else if (err == ESP_OK && rendered_state_valid) {
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
    if (in_panel) {
        lan_overlay_forget(&lan_overlay);
        notice_overlay_forget(&notice);
    }
    lan_overlay_end(&lan_overlay); /* already out on every path; never into the snapshot */
    notice_overlay_end(&notice);
    if (err == ESP_OK) {
        if (skipped_refresh && rendered_state_valid) {
            s_display_state = rendered_state;
            s_display_state_valid = true;
        }
        s_render_count++;
        s_last_render_ms = (esp_timer_get_time() - start) / 1000;
        /* A render without the notice took it off the panel. */
        if (!notice.drawn && !skipped_refresh) s_notice_shown_us = 0;
        if (!snapshot_stored) {
            store_snapshot(buf, buf_len, width, height, format, s_render_count, s_last_render_ms,
                           in_panel);
        }
        ESP_LOGI(TAG, "render #%lu done in %lld ms",
                 (unsigned long)s_render_count, s_last_render_ms);
        s_render_recovery_restarts = 0; /* a good render clears the streak */
        if (s_render_count == 1) {
            ESP_LOGI(TAG, "render task stack free at low-water mark: %u bytes",
                     (unsigned)uxTaskGetStackHighWaterMark(NULL));
            /* "Reached rendering" is the rollback window: a new image that
             * got this far has booted, brought the panel up, run the Nim
             * runtime and drawn a scene. Before this point any reset rolls
             * back to the previous slot (main.c no longer marks on Wi-Fi). */
            fos_ota_mark_boot_valid();
        }
    }
    int64_t total_ms = (esp_timer_get_time() - start) / 1000;
    s_render_attempts++;
    /* A quiet frame that failed is logged anyway: a broken animation must say
     * why at once, not ten seconds later. */
    if (!quiet || err != ESP_OK) {
        current_scene_details(scene_id, sizeof(scene_id), scene_name, sizeof(scene_name));
        log_render_event(err == ESP_OK ? "render:done" : "render:error", scene_id,
                         scene_name, err == ESP_OK ? "ok" : "error", "complete",
                         mode, refresh, err == ESP_OK ? "" : "render-cycle-failed",
                         err == ESP_OK ? s_render_count : render_attempt, total_ms,
                         width, height, format, buf_len, err);
        frameos_nim_flush_logs();
    }
    if (err == ESP_OK && !skipped_refresh && !quiet) {
        /* "I drew something new" — the provider decides whether anyone is
         * looking and fetches the image with image_get if so. */
        fos_cloud_announce_render(scene_id);
    }
    if (err == ESP_OK && !quiet) {
        /* Also on a skipped refresh: the last push may have failed. */
        push_image_to_backend(scene_id);
    }
    if (in_panel) {
        /* Shown: fos_display_blit gave the panel back. Not shown (the render
         * failed): give it back with the last picture still on the glass. */
        if (err != ESP_OK) fos_display_release_render_target();
    } else {
        /* Returns the reservation to the pool, or frees a one-off allocation —
         * including the Nim renderer's buffer on the local-render path. */
        fos_framebuffer_release(buf);
    }
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
    if (heap_caps_get_total_size(MALLOC_CAP_SPIRAM) == 0) {
        /* No PSRAM, so no rescue ever fires (see render_failure_recover) and
         * nothing to stay paused for. Also clears a streak left in RTC memory
         * by a firmware that still counted on such boards: an OTA reboot is a
         * software reset, so that frame would otherwise come up paused. */
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
    /* The rescue exists for boards where a failed render can leave PSRAM
     * held forever. A board with no PSRAM at all (ESP32-C3 thin clients)
     * cannot be in that state, yet its free-PSRAM reading is 0 — below any
     * threshold — so without this check every ordinary render failure (a
     * fetch that timed out, the server not ready yet) counted as a memory
     * rescue: reboot, and after two in a row the frame paused rendering
     * blaming "exhausted PSRAM". Seen in the field on a C3. */
    if (heap_caps_get_total_size(MALLOC_CAP_SPIRAM) == 0) {
        return;
    }
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

/* Local minus UTC at `utc`, as the schedule reads it: the configured zone
 * (DST-aware) beats the flat offset a provider pushed. */
static int local_offset_minutes_at(int64_t utc)
{
    return fos_tz_active() ? fos_tz_offset_minutes((time_t)utc) : fos_schedule_utc_offset_minutes();
}

/* How long to wait before the next render, in milliseconds.
 *
 * wake_schedule + a synced clock → align to the LOCAL clock's interval
 * boundaries (a 1h frame wakes at the top of the hour, a 5min frame on
 * :00/:05/..., a daily one at local midnight — fos_wake.h), which is what
 * makes clock faces tick on time. Otherwise an interval from `due_at_us`,
 * when this pass's render was due (the pass's start when nothing scheduled
 * it), so the time spent since (boot + Wi-Fi + render) comes off and the
 * period stays the interval instead of drifting by it. A deep sleep rounds
 * this up to whole seconds; an awake wait keeps the milliseconds: in whole
 * seconds a one-second clock whose render took half of one waited a whole
 * second after it, and showed every other second. */
static uint32_t compute_sleep_ms(uint32_t interval, int64_t due_at_us)
{
    fos_config_t *config = fos_config();
    if (interval == 0) interval = 1;
    int64_t left_ms = -1;
    if (config->wake_schedule && fos_wifi_time_synced()) {
        struct timeval now;
        gettimeofday(&now, NULL);
        if (now.tv_sec > 1000000000) { /* clock actually set, not 1970 */
            left_ms = fos_wake_aligned_sleep_ms((int64_t)now.tv_sec * 1000 + now.tv_usec / 1000, interval,
                                                local_offset_minutes_at);
        }
    }
    if (left_ms < 0) {
        left_ms = (int64_t)interval * 1000 - (esp_timer_get_time() - due_at_us) / 1000;
    }
    if (left_ms < 1) return 1;
    return left_ms > (int64_t)UINT32_MAX ? UINT32_MAX : (uint32_t)left_ms;
}

/* ------------------------------------------------------- animation mode */

/* A scene below a one-second interval on an LCD (fos_animation.h). */
static fos_animation_t s_anim;
static esp_timer_handle_t s_frame_timer = NULL;
static bool s_quiet = false;
/* Somebody asked for a render while an animation ran (a cloud or HTTP
 * render, a scene switch): that frame logs in full, so its render:done and
 * the cloud's render announce do not wait for the next ten seconds. */
static bool s_loud_next = false;
/* The pass about to start renders because the scene asked (SCENE_RENDER_BIT)
 * and nothing else did: a frame of a burst (fos_animation.h). */
static bool s_scene_render = false;
/* The pass-start power decision, kept between the once-a-second passes that
 * make it while animating. */
static bool s_pass_battery_critical = false;
static bool s_pass_deep_sleep = false;
static int s_pass_battery_pct = -1;

static void frame_timer_fired(void *arg)
{
    (void)arg;
    if (s_events) xEventGroupSetBits(s_events, FRAME_DUE_BIT);
}

static void set_quiet(bool quiet)
{
    if (quiet == s_quiet) return;
    s_quiet = quiet;
    frameos_nim_set_quiet(quiet);
}

/* `render:animation`: a start, the frames since the last full log (`running`,
 * once every FOS_ANIMATION_LOG_US, before the frame that logs), or a stop. */
static void log_animation(const char *status, bool logged_frame)
{
    fos_animation_stats_t stats;
    bool any = fos_animation_take_stats(&s_anim, esp_timer_get_time(), logged_frame, &stats);
    char line[320];
    if (strcmp(status, "start") == 0) {
        snprintf(line, sizeof(line),
                 "{\"event\":\"render:animation\",\"source\":\"esp32\",\"status\":\"start\","
                 "\"periodMs\":%lu}",
                 (unsigned long)((s_anim.period_us + 500) / 1000));
    } else if (any) {
        /* What an animation costs in memory, beside how fast it runs: the
         * interpreters it keeps between frames, and what is left. */
        snprintf(line, sizeof(line),
                 "{\"event\":\"render:animation\",\"source\":\"esp32\",\"status\":\"%s\","
                 "\"frames\":%lu,\"seconds\":%.1f,\"fps\":%lu.%lu,\"avgMs\":%lu,\"maxMs\":%lu,"
                 "\"periodMs\":%lu,\"jsKB\":%u,\"freePsramKB\":%u,\"largestPsramKB\":%u}",
                 status, (unsigned long)stats.frames, (double)stats.window_us / 1000000.0,
                 (unsigned long)(stats.fps_x10 / 10), (unsigned long)(stats.fps_x10 % 10),
                 (unsigned long)stats.avg_ms, (unsigned long)stats.max_ms,
                 (unsigned long)stats.period_ms,
                 (unsigned)(frameos_nim_js_runtime_bytes() / 1024),
                 (unsigned)(heap_caps_get_free_size(MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT) / 1024),
                 (unsigned)(fos_heap_largest_free_block(MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT) / 1024));
    } else if (strcmp(status, "stop") == 0) {
        snprintf(line, sizeof(line),
                 "{\"event\":\"render:animation\",\"source\":\"esp32\",\"status\":\"stop\"}");
    } else {
        return;
    }
    frameos_nim_log_hook(line);
}

/* A burst (fos_animation.h) a second over: `render:burst` with its frames,
 * and, when its last frame was quiet, the cloud's render announce and the
 * backend push that frame skipped, so neither keeps an older picture. */
static void finish_burst(void)
{
    fos_animation_stats_t stats;
    bool owed = false;
    if (!fos_animation_burst_end(&s_anim, esp_timer_get_time(), &stats, &owed)) return;
    char line[256];
    snprintf(line, sizeof(line),
             "{\"event\":\"render:burst\",\"source\":\"esp32\",\"frames\":%lu,\"seconds\":%.1f,"
             "\"fps\":%lu.%lu,\"avgMs\":%lu,\"maxMs\":%lu}",
             (unsigned long)stats.frames, (double)stats.window_us / 1000000.0,
             (unsigned long)(stats.fps_x10 / 10), (unsigned long)(stats.fps_x10 % 10),
             (unsigned long)stats.avg_ms, (unsigned long)stats.max_ms);
    frameos_nim_log_hook(line);
    if (owed) {
        char scene_id[128];
        char scene_name[128];
        current_scene_details(scene_id, sizeof(scene_id), scene_name, sizeof(scene_name));
        fos_cloud_announce_render(scene_id);
        push_image_to_backend(scene_id);
    }
    frameos_nim_flush_logs();
}

/* The wait between two frames of an animation. What arrives meanwhile is
 * served the way the ordinary wait below serves it: a press or a touch goes
 * to the scene, a command pull runs, the schedule ticks, and a render asked
 * for makes the next frame one that logs in full. A frame slower than the
 * interval waits for nothing, but the signals are read all the same. A voice
 * session's hold keeps the panel until its release (whose render carries the
 * notice). Returns when the next frame is due. */
static void animation_wait(fos_config_t *config, int64_t wait_us)
{
    const EventBits_t signals = RENDER_NOW_BIT | INPUT_EVENTS_BIT | COMMANDS_BIT | RELEASE_BIT | SCENE_RENDER_BIT;
    bool armed = false;
    if (wait_us > 0 && s_frame_timer) {
        esp_timer_stop(s_frame_timer);
        xEventGroupClearBits(s_events, FRAME_DUE_BIT);
        armed = esp_timer_start_once(s_frame_timer, (uint64_t)wait_us) == ESP_OK;
    }
    while (true) {
        EventBits_t bits = armed || render_held()
            ? xEventGroupWaitBits(s_events, signals | FRAME_DUE_BIT, pdTRUE, pdFALSE,
                                  pdMS_TO_TICKS(armed ? 1000 : 100))
            : xEventGroupClearBits(s_events, signals); /* the bits before the clear */
        bool nim = config->render_mode == FOS_RENDER_LOCAL && frameos_nim_available();
        if ((bits & COMMANDS_BIT) && fos_commands_sync() && nim) {
            fos_scenes_apply_pending_selection();
        }
        if (nim) {
            process_input_events();
            fos_events_deliver_deferred();
            fos_schedule_tick();
        }
        if (bits & RENDER_NOW_BIT) s_loud_next = true;
        bool due = !armed || (bits & (FRAME_DUE_BIT | RENDER_NOW_BIT | SCENE_RENDER_BIT)) != 0 ||
                   (nim && frameos_nim_render_requested()) ||
                   fos_animation_wait_us(&s_anim, esp_timer_get_time()) == 0;
        if (due && !render_held()) break;
    }
    if (armed) esp_timer_stop(s_frame_timer);
}

static void client_task(void *arg)
{
    fos_config_t *config = fos_config();
    /* Set when the sleep wait below broke early on an explicit render signal
     * (cloud/HTTP render verb, button, schedule tick, scene request): the
     * next pass must render even if the wake-check bookkeeping says the
     * scheduled render is not due yet. */
    bool force_render = false;
    /* When the last pass's wait ran out, uninterrupted: this pass's render was
     * due then, and the next one is an interval after that, not after this
     * pass began. Counted from each pass, a one-second clock came round every
     * 1.03 s and showed one second twice every half minute. 0 otherwise. */
    int64_t wait_ended_us = 0;
    xEventGroupWaitBits(s_events, START_RENDER_LOOP_BIT, pdFALSE, pdFALSE, portMAX_DELAY);
    {
        /* A button woke the chip: this pass renders, whatever the wake-check
         * bookkeeping says — the person pressing it wants to see something
         * happen, and the replayed press (fos_buttons_start) reaches the scene
         * on this same pass. Say why the frame is up either way: the
         * `bootup` event fires before the cloud session exists and is lost,
         * so this is the first line a wake leaves in cloud retention. */
        int wake_pin = -1;
        char wake_label[FOS_GPIO_BUTTON_LABEL_LEN] = "";
        char label_esc[FOS_GPIO_BUTTON_LABEL_LEN * 2];
        bool button_wake = fos_buttons_woke_by_button(&wake_pin, wake_label, sizeof(wake_label));
        force_render = button_wake;
        json_escape_value(wake_label, label_esc, sizeof(label_esc));
        char line[192];
        if (button_wake) {
            /* `mask`: every pad the wake reported low. One bit, and the pin
             * is beyond dispute; a label dispute (E1004, 2026-10-12: "I
             * pressed right, it says refresh") is then about the preset. */
            snprintf(line, sizeof(line),
                     "{\"event\":\"wake\",\"source\":\"esp32\",\"cause\":\"button\","
                     "\"pin\":%d,\"label\":\"%s\",\"mask\":\"0x%llx\"}", wake_pin, label_esc,
                     (unsigned long long)fos_buttons_wake_mask());
        } else {
            snprintf(line, sizeof(line),
                     "{\"event\":\"wake\",\"source\":\"esp32\",\"cause\":\"%s\"}",
                     wake_cause_name());
        }
        frameos_nim_log_hook(line);
        /* The verdict of an OTA that restarted the chip before its line
         * could leave (the early-boot updater runs before the uploads
         * exist): logged again now, so the control plane's row ends in
         * `verified` → done, or in the error the device saw. */
        fos_ota_replay_last_line();
        /* The RTC due date is only meaningful across a deep sleep: after an
         * OTA, an OOM restart or a power cycle the panel may show anything,
         * so the first pass renders whatever the old bookkeeping said. */
        if (esp_reset_reason() != ESP_RST_DEEPSLEEP) {
            s_next_render_due = 0;
        }
    }
    while (true) {
        /* The provisioning portal owns the panel: its screen carries the
         * hotspot name and passphrase, and the first scene render painted
         * straight over it (2026-09-04, E1002 showed the word clock while
         * the owner was looking for the hotspot details). Hold here until
         * the stored network answers — on_portal_exit renders — or the
         * portal is left for good. Signals that arrive meanwhile (a button,
         * a schedule tick) are honoured by the pass after that. */
        if (fos_wifi_state() == FOS_WIFI_PORTAL) {
            vTaskDelay(pdMS_TO_TICKS(1000));
            continue;
        }
        int64_t cycle_start = esp_timer_get_time();
        int64_t due_at_us = wait_ended_us ? wait_ended_us : cycle_start;
        wait_ended_us = 0;
        /* Animation mode (fos_animation.h): the pulls, the sensors and the
         * settings pushes below run once a second, not once a frame. Outside
         * animation every pass does them. */
        bool housekeeping = fos_animation_housekeeping_due(&s_anim, cycle_start);
        /* Scene state that has waited its delay (fos_scene_state.h). */
        if (housekeeping) fos_scene_state_flush(false);

        /* First pass of a boot on a cloud-managed frame: the commands that
         * waited out the sleep (a scene switch, a scenes push, a state) are
         * delivered right after the session's ready frame, and the backend
         * equivalent below (fos_commands_sync) already runs before the
         * render for the same reason. Without this the pass rendered the
         * old scene while the socket came up, then rendered again. */
        bool cloud_socket_waited_out = false;
        if (s_render_attempts == 0 && !s_render_paused_for_memory &&
            config->render_mode == FOS_RENDER_LOCAL && frameos_nim_available() &&
            fos_cloud_state() == FOS_CLOUD_ENROLLED &&
            fos_wifi_state() == FOS_WIFI_CONNECTED) {
            int64_t wait_start = esp_timer_get_time();
            int announced = -1;
            bool drained = fos_cloud_wait_initial_commands(FOS_CLOUD_BOOT_COMMANDS_WAIT_MS,
                                                           &announced);
            cloud_socket_waited_out = !drained && !fos_cloud_ws_connected();
            char line[160];
            snprintf(line, sizeof(line),
                     "{\"event\":\"cloud:boot_commands\",\"source\":\"esp32\","
                     "\"status\":\"%s\",\"pending\":%d,\"waitedMs\":%lld}",
                     drained ? "drained" : fos_cloud_ws_connected() ? "timeout" : "no_session",
                     announced, (long long)((esp_timer_get_time() - wait_start) / 1000));
            frameos_nim_log_hook(line);
        }

        /* Interpreted scenes: pick up backend changes and any payload
         * pushed over HTTP/console since the last pass. Both touch the Nim
         * runtime, so they only ever run here on the render task. */
        if (config->render_mode == FOS_RENDER_LOCAL && frameos_nim_available()) {
            if (housekeeping) fos_scenes_sync(false);
            fos_scenes_apply_pending();
            /* Scene events from HTTP, the cloud or the console since the last
             * look (fos_events_defer): to the scene now, before this pass
             * renders, and the render shows them — as the scene's own render
             * when nothing else forced this pass. Before the queued switch
             * is applied: a `setCurrentScene` with state leaves that state
             * pending here, and the switch opens the scene with it. */
            if (fos_events_deliver_deferred() && !force_render) {
                force_render = true;
                s_scene_render = true;
            }
            fos_scenes_apply_pending_selection();
            process_input_events();
            /* A press that dispatched `setCurrentScene` (a scene's next/prev
             * button) only queued the switch. Apply it now, so this pass
             * renders the scene it asked for: after a button wake the frame
             * renders once and goes back to deep sleep, which loses the
             * queue. */
            fos_scenes_apply_pending_selection();
        }

        /* The once-a-second work while animating starts here and ends with
         * the power decision. */
        if (housekeeping) {
            /* Live settings: pick up backend-side interval/name/render-mode
             * changes without a rebuild. ETag'd, so steady state is a 304. */
            fos_settings_sync(false);
            /* The backend's command queue — what the workspace asked for while
             * this frame slept (a scene switch, a state, a render, an update) —
             * before the render, so a switch lands in THIS pass's render instead
             * of costing a second panel refresh. */
            if (fos_commands_sync() && config->render_mode == FOS_RENDER_LOCAL &&
                frameos_nim_available()) {
                fos_scenes_apply_pending_selection();
            }
            /* A zone name with no tzdata slice yet (console `set time_zone`,
             * an older provider): one fetch from tz.frameos.net, rate-limited. */
            fos_tz_resolve_pending();

            /* A console `set spill_force` may have changed it since last pass. */
            fos_nim_http_set_spill_force_bytes(config->http_spill_force_bytes);
            /* Same for `set debug`: the per-node memory profile is meant to be
             * switched on over the console mid-flight, without a rebuild. */
            frameos_nim_set_debug(config->debug_logging ? 1 : 0);
            frameos_nim_set_fusion(config->image_fusion ? 1 : 0);
            /* Fallback fit for consumers without their own placement — settings
             * sync, cloud set_settings and the console all write it live. */
            frameos_nim_set_scaling_mode(config->scaling_mode);
            /* The colours block (automatic fit switch, frame-wide correction):
             * same contract, the Nim side re-parses only when the text changed. */
            frameos_nim_set_colors(config->colors);
            frameos_nim_set_palette(config->palette);
            /* The frame's button bindings (docs/events.md "Event map"), the same
             * way: the dispatcher reads them off its config on the next press. */
            frameos_nim_set_event_map(config->event_map);
            /* Same contract for the zone name: live, one string per pass. */
            frameos_nim_set_time_zone(config->time_zone);

            /* Battery guardrail: when the cell is nearly empty, skip the (costly)
             * render + panel refresh and sleep long so a low battery can't keep
             * cycling the display down to a damaging voltage. Two bursts a
             * moment apart, the higher one wins (a radio burst can only sag a
             * reading, never inflate it); fos_power_decide then weighs it
             * against the state carried in RTC memory — see fos_power.h for the
             * log this replays. */
            int battery_pct = -1, battery_mv = 0;
            if (fos_battery_present()) {
                fos_battery_read(&battery_mv, &battery_pct);
                vTaskDelay(pdMS_TO_TICKS(FOS_BATTERY_RESAMPLE_GAP_MS));
                int again_mv = 0, again_pct = -1;
                fos_battery_read(&again_mv, &again_pct);
                if (again_mv > battery_mv) {
                    battery_mv = again_mv;
                    battery_pct = again_pct;
                }
            }
            /* A clock write SNTP could not land yet (fos_rtc.c). */
            fos_rtc_retry_pending();
            /* The charger, where the board has one (fos_charger.c): USB in means
             * not on battery, whatever the divider reads of a charging cell. */
            fos_charger_status_t charger;
            bool charger_known = fos_charger_present() && fos_charger_read(&charger) == ESP_OK;
            fos_gauge_status_t gauge;
            if (!charger_known && fos_gauge_present() && fos_gauge_read(&gauge) == ESP_OK && gauge.present) {
                memset(&charger, 0, sizeof(charger));
                charger.usb_power = !gauge.discharging;
                charger.charging = gauge.charging;
                charger.charge_done = gauge.full;
                charger_known = true;
            }
            fos_power_input_t power_in = {
                .mv = battery_mv,
                .deep_sleep = config->deep_sleep,
                .deep_sleep_on_battery = config->deep_sleep_on_battery,
                .usb_power = charger_known ? (charger.usb_power ? 1 : 0) : -1,
            };
            fos_power_decision_t power;
            fos_power_decide(&power_in, &s_power_state, &power);
            bool battery_critical = power.critical;
            bool deep_sleep_now = power.deep_sleep;
            /* Say what this pass decided and from what: the one line that tells
             * "deep sleep silently off" from "the owner switched it off". Only
             * where it can say something — a stay-connected frame without a
             * cell would just repeat "off" every interval. */
            if (config->deep_sleep || config->deep_sleep_on_battery || power.suspect ||
                power.critical) {
                char line[256];
                size_t used = (size_t)snprintf(
                    line, sizeof(line),
                    "{\"event\":\"power\",\"source\":\"esp32\",\"deepSleep\":\"%s\","
                    "\"onBattery\":%s,\"wakeCheckSeconds\":%lu",
                    !deep_sleep_now ? "off" : config->deep_sleep ? "always"
                                      : battery_critical ? "critical" : "battery",
                    power.on_battery ? "true" : "false",
                    (unsigned long)config->wake_check_sec);
                if (fos_battery_present() && used < sizeof(line) - 96) {
                    used += (size_t)snprintf(line + used, sizeof(line) - used,
                                             ",\"batteryMillivolts\":%d,\"batteryPercent\":%d",
                                             battery_mv, battery_pct);
                    if (power.mv_used != battery_mv) {
                        used += (size_t)snprintf(line + used, sizeof(line) - used,
                                                 ",\"believedMillivolts\":%d", power.mv_used);
                    }
                }
                if (power.suspect && used < sizeof(line) - 24) {
                    used += (size_t)snprintf(line + used, sizeof(line) - used, ",\"suspect\":true");
                }
                if (charger_known && used < sizeof(line) - 40) {
                    used += (size_t)snprintf(line + used, sizeof(line) - used, ",\"usbPower\":%s,\"charging\":%s",
                                             charger.usb_power ? "true" : "false",
                                             charger.charging ? "true" : "false");
                }
                if (used < sizeof(line) - 2) {
                    snprintf(line + used, sizeof(line) - used, "}");
                    frameos_nim_log_hook(line);
                }
            }
            s_pass_battery_critical = battery_critical;
            s_pass_deep_sleep = deep_sleep_now;
            s_pass_battery_pct = battery_pct;
            /* A frame that stays awake keeps its scene's JS interpreters
             * between renders while there is room; a deep sleep ends them
             * anyway. */
            frameos_nim_set_keep_js(!deep_sleep_now);
        }
        bool battery_critical = s_pass_battery_critical;
        bool deep_sleep_now = s_pass_deep_sleep;
        int battery_pct = s_pass_battery_pct;
        /* A wake-check pass: this deep-sleeping frame woke early (or is held
         * awake) only to check the control plane for commands — the panel's
         * scheduled render is not due yet, so skip the costly refresh. An
         * explicit render signal always wins. */
        time_t wall_now = time(NULL);
        bool clock_ok = fos_wifi_time_synced() && wall_now > 1000000000;
        /* Not gated on wake_check_seconds: a keep-awake hold (a verb that
         * arrived as the pass ended) also lands here with the due date still
         * ahead, and used to render the same scene a second time. */
        /* This pass switched the resident scene (a cloud "install and
         * activate", a setCurrentScene, a deploy that landed since boot):
         * the panel shows the previous one, so a check-in wake renders
         * after all — without this the switch stayed invisible until the
         * scheduled render, hours later on a battery frame. */
        if (fos_scenes_take_switched()) {
            force_render = true;
        }
        /* A local network access code to show, or one to take off the panel. */
        if (lan_access_panel_changed()) {
            force_render = true;
        }
        bool checkin_pass = deep_sleep_now && !force_render && clock_ok &&
                            s_next_render_due > wall_now + 2 &&
                            /* a due date past the longest allowed interval is
                             * garbage (clock jump, stale RTC) — render */
                            s_next_render_due < wall_now + 7 * 86400 + 3600;
        /* A render the scene asked for is not one somebody asked for: a run
         * of them is a burst, logged like an animation. Not on a frame about
         * to deep-sleep, which would never make up a quiet frame's skips. */
        bool scene_render = s_scene_render && !deep_sleep_now;
        s_scene_render = false;
        if (force_render && !scene_render) s_loud_next = true;
        force_render = false;
        bool rendered = false;
        bool frame_quiet = false;
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
                /* The OTA task waits for a render that is already under way
                 * (fos_client_render_in_flight); a pass that starts while it
                 * is busy yields instead, so the two never share the link. */
                ESP_LOGW(TAG, "OTA in progress; skipping render cycle");
                log_render_skipped("ota", -1);
            } else {
                /* An animation logs one frame in full every so often, with
                 * the summary of the quiet ones before it. */
                int64_t frame_start = esp_timer_get_time();
                bool quiet = !s_loud_next && (fos_animation_frame_quiet(&s_anim, frame_start) ||
                                              (scene_render && fos_animation_burst_quiet(&s_anim, frame_start)));
                frame_quiet = quiet;
                s_loud_next = false;
                if (s_anim.active && !quiet) log_animation("running", true);
                set_quiet(quiet);
                s_render_in_flight = true;
                render_once(quiet);
                s_render_in_flight = false;
                rendered = true;
                fos_animation_frame_done(&s_anim, cycle_start, esp_timer_get_time());
                if (scene_render) {
                    fos_animation_burst_frame_done(&s_anim, frame_start, esp_timer_get_time(), quiet);
                }
            }
        }
        /* An animation samples with the frame it logs in full, every ten
         * seconds: a sample is three heap walks and a line the provider's
         * Metrics panel stores, and once a second was 3,600 an hour. A pass
         * that renders nothing keeps the once-a-second housekeeping. */
        bool sample_metrics = (s_anim.active || scene_render) && rendered ? !frame_quiet : housekeeping;
        if (sample_metrics) log_metrics_sample();
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

        /* A scene that asks for frames faster than once a second, on an LCD:
         * paced in microseconds from here, the whole-second sleep below
         * skipped (fos_animation.h). */
        bool animate = config->render_mode == FOS_RENDER_LOCAL && frameos_nim_available() &&
                       !battery_critical && !s_render_paused_for_memory &&
                       fos_animation_wanted(scene_interval, fos_display_is_lcd(), deep_sleep_now);
        if (fos_animation_update(&s_anim, animate, scene_interval, esp_timer_get_time())) {
            if (s_anim.active) {
                log_animation("start", false);
            } else {
                log_animation("stop", false);
                set_quiet(false);
            }
        }
        if (s_anim.active) {
            if (rendered) {
                /* logic/nextSleepDuration, in the animation's own units. */
                double next_sleep = frameos_nim_next_sleep();
                if (next_sleep >= 0.0) {
                    if (next_sleep > 7 * 86400.0) next_sleep = 7 * 86400.0;
                    s_anim.next_due_us = cycle_start + (int64_t)(next_sleep * 1000000.0);
                }
            }
            /* Core 1 is the render task's and the refill interrupt's; a frame
             * slower than the panel never blocks, so let the idle task run
             * once a second (the task watchdog watches it). */
            if (housekeeping) vTaskDelay(1);
            animation_wait(config, fos_animation_wait_us(&s_anim, esp_timer_get_time()));
            continue;
        }

        int64_t sleep_decided_us = esp_timer_get_time();
        uint32_t sleep_ms = compute_sleep_ms(interval, due_at_us);
        uint32_t sleep_s = (uint32_t)(((uint64_t)sleep_ms + 999) / 1000);
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
        /* The next panel refresh is due at the end of this wait — whether the
         * wait is a deep sleep (the RTC keeps it) or an awake hold cut short
         * by a keep-awake, whose follow-up pass must then check in, not
         * render again. */
        s_next_render_due = clock_ok ? time(NULL) + (time_t)sleep_s : 0;
        /* A key still down, or a tap inside its double-press window: the
         * dispatcher has a `longPress`, `press` or `doublePress` still to
         * deliver, and only a tick delivers it. A battery frame that slept
         * now would lose it (the tap's window is 350 ms; a held key is let
         * go within seconds, and 10 s caps a stuck one). Wait it out,
         * ticking, and render if the scene asked. */
        if (deep_sleep_now && config->render_mode == FOS_RENDER_LOCAL && frameos_nim_available() &&
            fos_buttons_busy()) {
            int64_t settle_start_us = esp_timer_get_time();
            while (fos_buttons_busy() && esp_timer_get_time() - settle_start_us < 10 * 1000000LL) {
                vTaskDelay(pdMS_TO_TICKS(20));
                process_input_events();
            }
            process_input_events();
            if (frameos_nim_render_requested()) {
                force_render = true;
                continue;
            }
        }
        uint32_t keep_awake_s = keep_awake_remaining_seconds();
        bool button_pending = config->render_mode == FOS_RENDER_LOCAL && frameos_nim_available() &&
                              (fos_buttons_pending() || fos_touch_pending());
        if (deep_sleep_now && fos_display_present() && config->render_mode == FOS_RENDER_LOCAL &&
            frameos_nim_available() && !render_held() &&
            (fos_scenes_work_pending() || fos_events_deferred_pending() || button_pending)) {
            /* A scene payload or a scene switch arrived while this pass was
             * rendering (the cloud delivers them the moment the session is
             * up, and a 13.3" render takes a minute). Sleeping now would
             * leave the old scene on the panel until the next wake — and
             * the switch itself in RAM, lost. One more pass applies and
             * renders it; the apply consumes the work, so this cannot loop.
             * A deferred scene event (a setSceneState the cloud sent during
             * the render) holds the sleep the same way, and so does a button
             * pressed during the render: the queue is drained only at the
             * start of a pass and in the idle wait, neither of which a
             * battery frame reaches between its render and its sleep, so the
             * press vanished without a log line (E1004, 2026-10-12: two
             * right-arrow presses during a refresh, nothing in the log). */
            char held[96];
            snprintf(held, sizeof(held),
                     "{\"event\":\"sleep:held\",\"source\":\"esp32\",\"reason\":\"%s\"}",
                     button_pending ? "button" : "scenes");
            frameos_nim_log_hook(held);
            force_render = true;
            continue;
        }
        if (deep_sleep_now && fos_display_present() && fos_cloud_asset_jobs_pending()) {
            /* An image_get is queued or streaming (the provider fetches the
             * frame's image on this pass's `render` announcement while
             * someone is looking). A few seconds now beats an image that is
             * never delivered. */
            int64_t hold_end = esp_timer_get_time() +
                               (int64_t)FOS_ASSET_SLEEP_HOLD_MAX_SEC * 1000000LL;
            frameos_nim_log_hook("{\"event\":\"sleep:held\",\"source\":\"esp32\","
                                 "\"reason\":\"image\"}");
            while (fos_cloud_asset_jobs_pending() && esp_timer_get_time() < hold_end) {
                vTaskDelay(pdMS_TO_TICKS(250));
            }
            keep_awake_s = keep_awake_remaining_seconds();
        }
        if (deep_sleep_now && fos_display_present() && fos_ota_busy()) {
            /* See FOS_OTA_SLEEP_HOLD_MAX_SEC. Success reboots from inside the
             * OTA task; failure clears busy and we fall through to sleep. */
            int64_t hold_end = esp_timer_get_time() +
                               (int64_t)FOS_OTA_SLEEP_HOLD_MAX_SEC * 1000000LL;
            ESP_LOGW(TAG, "OTA in progress; holding deep sleep until it finishes");
            frameos_nim_log_hook("{\"event\":\"sleep:held\",\"source\":\"esp32\","
                                 "\"reason\":\"ota\"}");
            while (fos_ota_busy() && esp_timer_get_time() < hold_end) {
                vTaskDelay(pdMS_TO_TICKS(1000));
            }
            if (fos_ota_busy()) {
                ESP_LOGW(TAG, "OTA still busy after %d s; sleeping anyway",
                         FOS_OTA_SLEEP_HOLD_MAX_SEC);
            }
            keep_awake_s = keep_awake_remaining_seconds();
        }
        if (deep_sleep_now && fos_display_present() && keep_awake_s == 0 &&
            fos_cloud_state() == FOS_CLOUD_ENROLLED && fos_wifi_ip()[0] != '\0' &&
            !fos_cloud_ws_connected() && !cloud_socket_waited_out) {
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
            /* What the scene changed is all the next wake has of it. */
            fos_scene_state_flush(true);
            /* Wake early to check the control plane for commands when asked
             * to — the render schedule itself survives in s_next_render_due
             * (RTC memory), so the check-in wake does not refresh the panel. */
            uint32_t chunk = sleep_s;
            if (config->wake_check_sec >= 60 && chunk > config->wake_check_sec) {
                chunk = config->wake_check_sec;
            }
            bool wake_check = chunk < sleep_s;
            ESP_LOGI(TAG, "deep sleeping for %lu s%s%s", (unsigned long)chunk,
                     config->wake_schedule ? " (wake-on-schedule)" : "",
                     wake_check ? " (wake-check)" : "");
            /* Say when we are back before going dark: a structured log line
             * for the backend / Logs panel, and the provider's `sleep`
             * message so the workspace can show "asleep · wakes in 5 min"
             * instead of "last seen just now" for the next six hours. */
            const char *sleep_reason = battery_critical ? "battery_critical"
                                       : config->deep_sleep ? "always"
                                                            : "battery";
            /* Any registered button on a wake-capable pad brings the frame
             * back early (fos_buttons.h); the timer below stays armed too. */
            uint64_t wake_buttons = 0;
            fos_buttons_arm_wake(&wake_buttons);
            {
                char pins[96] = "";
                size_t used = 0;
                for (int pin = 0; pin < 64 && used + 4 < sizeof(pins); pin++) {
                    if ((wake_buttons & (1ULL << pin)) == 0) continue;
                    used += (size_t)snprintf(pins + used, sizeof(pins) - used, "%s%d",
                                             used ? "," : "", pin);
                }
                char line[288];
                snprintf(line, sizeof(line),
                         "{\"event\":\"sleep\",\"source\":\"esp32\",\"wakeInSeconds\":%lu,"
                         "\"nextRenderAt\":%lld,\"reason\":\"%s\",\"wakeCheck\":%s,"
                         "\"wakeButtons\":[%s]}",
                         (unsigned long)chunk, (long long)s_next_render_due, sleep_reason,
                         wake_check ? "true" : "false", pins);
                frameos_nim_log_hook(line);
                frameos_nim_flush_logs();
            }
            /* Let the cloud task put the queued lines (render:done, metrics,
             * the sleep line above) on the wire BEFORE the sleep announce:
             * the hub terminates the socket the moment it sees `sleep`. */
            fos_cloud_flush_logs(FOS_SLEEP_LOG_DRAIN_MS);
            if (fos_cloud_announce_sleep(chunk, (int64_t)s_next_render_due, sleep_reason,
                                         wake_check)) {
                /* The send returned once the bytes were handed to lwIP; give
                 * the stack a moment to actually put them on the air. */
                vTaskDelay(pdMS_TO_TICKS(250));
            }
            /* An orderly sleep is not a crash: a battery frame whose first
             * render after an update failed for a network reason must not
             * have its own wake-up (a bootloader pass) roll the image back.
             * A Nim panic never gets here — it resets first, and rolls back. */
            fos_ota_mark_boot_valid();
            /* USB console drops in deep sleep; that's the point (battery). */
            esp_deep_sleep((uint64_t)chunk * 1000000ULL);
        }
        if (deep_sleep_now && fos_display_present() && keep_awake_s > 0) {
            ESP_LOGI(TAG, "staying awake for %lu s after HTTP/console activity",
                     (unsigned long)keep_awake_s);
            if (sleep_s > keep_awake_s) sleep_s = keep_awake_s;
        }
        /* Wait in 1s slices so scene-dispatched "render" events (QuickJS
         * setting the redraw flag) take effect promptly, until a deadline:
         * the wait decided above, to the millisecond, or what is left of it
         * after a keep-awake or a retry shortened sleep_s. A slice a signal
         * ends early takes off only the time that passed, and none waits 0
         * ticks (fos_wake_slice_ticks): counted in slices of whole ms, the
         * last few ms of a wait were one, and the loop spun until a pass
         * happened to take that long. One pass at least, a tick long when
         * the render ran past its interval: what is queued is served, and
         * the idle task on this core runs between two renders. */
        int64_t wait_ms = (int64_t)sleep_s * 1000 < (int64_t)sleep_ms ? (int64_t)sleep_s * 1000 : sleep_ms;
        int64_t wait_until_us = sleep_decided_us + wait_ms * 1000;
        do {
            /* 50 ms while a button is busy: its `press` is due 350 ms after
             * the tap and its `longPress`es on each second, and only the
             * process_events below delivers them. */
            uint32_t max_slice = fos_buttons_busy() ? 50 : 1000;
            EventBits_t bits = xEventGroupWaitBits(
                s_events, RENDER_NOW_BIT | INPUT_EVENTS_BIT | COMMANDS_BIT | RELEASE_BIT | SCENE_RENDER_BIT,
                pdTRUE, pdFALSE,
                fos_wake_slice_ticks(wait_until_us - esp_timer_get_time(), max_slice, portTICK_PERIOD_MS));
            bool nim = config->render_mode == FOS_RENDER_LOCAL && frameos_nim_available();
            /* Somebody wants a render. Decided below: now, or — while a voice
             * session holds the panel — when it releases, in one pass. */
            bool want_render = (bits & RENDER_NOW_BIT) != 0;
            /* The scene's own ask, after a touch or a key: a burst's frame. */
            bool scene_asked = (bits & SCENE_RENDER_BIT) != 0;
            if (bits & COMMANDS_BIT) {
                /* The backend nudged: it just queued something for an awake
                 * frame. Pull now; whatever the commands asked for (a render,
                 * a switch) is picked up by the checks below. Before the
                 * release bit: the voice relay asks for this pull, then
                 * releases, so the pulled state is in this pass's render. */
                if (fos_commands_sync() && nim) {
                    fos_scenes_apply_pending_selection();
                }
                if (fos_client_render_pending()) {
                    xEventGroupClearBits(s_events, RENDER_NOW_BIT);
                    want_render = true;
                }
            }
            /* INPUT_EVENTS_BIT ends the slice early and nothing more: the
             * press is delivered just below, and the render-requested check
             * after it decides whether a frame follows. */
            fos_scene_state_flush(false);
            if (nim) {
                process_input_events();
                /* An event from HTTP, the cloud or the console: to the scene
                 * now, not at the next pass an interval away. Whether a frame
                 * follows is the scene's to say, read just below. */
                fos_events_deliver_deferred();
                /* Wall-clock schedule (setCurrentScene at 07:00 etc.) —
                 * evaluated on the render task, like every Nim call. */
                if (fos_schedule_tick()) want_render = true;
                if (frameos_nim_render_requested()) scene_asked = true;
                /* A burst a second over: its summary, and what its last
                 * frame skipped when that one was quiet. */
                finish_burst();
            }
            /* A code started (the verb wakes this wait), answered, replaced
             * or expired: within a second, whatever the interval. */
            if (lan_access_panel_changed()) want_render = true;
            if (render_held() && esp_timer_get_time() >= wait_until_us) {
                /* The interval ran out under the hold: that render is owed
                 * to the release too. */
                s_render_owed = true;
                wait_until_us = esp_timer_get_time() + 1000000;
            }
            if (bits & RELEASE_BIT) {
                /* The voice session is over and its answer is pending. A
                 * render owed from the hold (the chat's switch, its state, an
                 * interval that ran out) carries the notice; with none, the
                 * last image is repainted with it (repaint_with_notice). */
                if (want_render || s_render_owed || (s_notice_pending && !repaint_snapshot(true))) {
                    want_render = true;
                }
                s_render_owed = false;
            }
            /* The answer has been read: the panel goes back to the image
             * alone, unless a render is about to do that anyway. */
            if (!want_render && !scene_asked && notice_expired() && !render_held() &&
                !repaint_snapshot(false)) {
                s_notice_shown_us = 0; /* no snapshot to repaint from; the next render clears it */
            }
            if (want_render || scene_asked) {
                if (render_held()) {
                    /* A voice session is in flight: the chat's switch takes
                     * effect now (its state, the next command, goes to the
                     * new scene) and the render waits for the answer. */
                    s_render_owed = true;
                    if (nim) fos_scenes_apply_pending_selection();
                } else {
                    s_render_owed = false;
                    s_scene_render = !want_render;
                    force_render = true;
                    break;
                }
            } else if (s_render_owed && !render_held()) {
                /* The hold ran out without a release (the relay task is
                 * gone): render what it held back. */
                s_render_owed = false;
                force_render = true;
                break;
            }
        } while (esp_timer_get_time() < wait_until_us);
        if (!force_render) wait_ended_us = wait_until_us;
    }
}

void fos_client_start(void)
{
    if (s_events) return;
    s_events = xEventGroupCreate();
    s_snapshot_lock = xSemaphoreCreateMutex();
    fos_framebuffer_set_lend_hook(snapshot_before_lend);
    fos_display_set_before_write_hook(snapshot_before_panel_write);
    const esp_timer_create_args_t frame_timer_args = {
        .callback = frame_timer_fired,
        .name = "fos_frame",
    };
    if (esp_timer_create(&frame_timer_args, &s_frame_timer) != ESP_OK) s_frame_timer = NULL;
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
    /* On an RGB LCD the render task shares core 1 with the panel's refill
     * interrupt (lcd_st7701s_rgb.c): its bulk PSRAM copies pause while the
     * refill runs. Every other board leaves it to the scheduler. */
#if CONFIG_FREERTOS_NUMBER_OF_CORES > 1
    BaseType_t core = fos_display_is_lcd() ? 1 : tskNO_AFFINITY;
#else
    BaseType_t core = tskNO_AFFINITY;
#endif
    BaseType_t created = xTaskCreatePinnedToCore(client_task, "fos_client", CLIENT_TASK_STACK_BYTES,
                                                 NULL, 5, &s_client_task, core);
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

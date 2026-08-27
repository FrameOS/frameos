/*
 * FrameOS ESP32-S3 firmware.
 *
 * Boot: NVS config → display select → Wi-Fi (STA, or captive-portal
 * provisioning when unconfigured) → SNTP → HTTP server + render loop
 * (Nim runtime on-device, or thin client fetching backend bitmaps) → OTA.
 *
 * The serial console (USB) is always available: `help` for commands,
 * `wifi <ssid> [pass]` provisions a frame without the portal.
 */
#include <dirent.h>
#include <stdio.h>
#include <sys/stat.h>
#include <unistd.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "driver/gpio.h"
#include "esp_app_desc.h"
#include "esp_spiffs.h"
#include "esp_err.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_ota_ops.h"

#include "fos_assets.h"
#include "fos_assets_sd.h"
#include "fos_battery.h"
#include "fos_defaults.h"
#include "fos_buttons.h"
#include "fos_client.h"
#include "fos_cloud.h"
#include "fos_config.h"
#include "fos_console.h"
#include "fos_framebuffer.h"
#include "fos_http.h"
#include "fos_ota.h"
#include "fos_scenes.h"
#include "fos_schedule.h"
#include "fos_status_screen.h"
#include "fos_tz.h"
#include "fos_mem.h"
#include "fos_wifi.h"
#include "frameos_display.h"
#include "frameos_nim.h"

static const char *TAG = "frameos";

#define WIFI_CONNECT_TIMEOUT_MS 45000
#define SNTP_TIMEOUT_MS 10000

/* Heartbeat on the XIAO ESP32-S3 user LED (GPIO 21, active low). Slow
 * blink = running, fast blink = provisioning portal. Only the S3 gets a
 * default: on the C3 boards GPIO 21 is display CS (XTEINK X4) or I2C
 * (TRMNL), so "unconnected GPIO" no longer holds; boards without a plain
 * LED disable the task with -1. generated_config.h may override. */
#ifndef FRAMEOS_HEARTBEAT_GPIO
#if CONFIG_IDF_TARGET_ESP32S3
#define FRAMEOS_HEARTBEAT_GPIO 21
#else
#define FRAMEOS_HEARTBEAT_GPIO -1
#endif
#endif
#define HEARTBEAT_GPIO FRAMEOS_HEARTBEAT_GPIO

static volatile uint32_t s_blink_period_ms = 2000;

static void heartbeat_task(void *arg)
{
    gpio_reset_pin(HEARTBEAT_GPIO);
    gpio_set_direction(HEARTBEAT_GPIO, GPIO_MODE_OUTPUT);
    bool on = false;
    while (true) {
        on = !on;
        gpio_set_level(HEARTBEAT_GPIO, on ? 0 : 1);
        vTaskDelay(pdMS_TO_TICKS(s_blink_period_ms / 2));
    }
}

static void action_ota_now(void)
{
    ESP_LOGW(TAG, "manual OTA requested");
    esp_err_t err = fos_ota_request_check();
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "manual OTA request failed: %s", esp_err_to_name(err));
    }
}

static void action_render_now(void)
{
    fos_client_render_now();
}

static void log_bootup_event(bool online)
{
    fos_config_t *config = fos_config();
    const esp_app_desc_t *app = esp_app_get_description();
    int width = fos_display_present() ? fos_display_width() : 800;
    int height = fos_display_present() ? fos_display_height() : 480;
    int pixel_format = fos_display_present() ? (int)fos_display_format() : 1;
    char log_line[360];
    snprintf(log_line, sizeof(log_line),
             "{\"event\":\"bootup\",\"source\":\"esp32\",\"width\":%d,\"height\":%d,"
             "\"pixelFormat\":%d,\"mode\":\"embedded\",\"renderMode\":\"%s\","
             "\"version\":\"%s\",\"panel\":\"%s\",\"ip\":\"%s\",\"wifi\":\"%s\"}",
             width, height, pixel_format,
             config->render_mode == FOS_RENDER_LOCAL ? "local" : "remote",
             app->version, config->panel, fos_wifi_ip(), online ? "connected" : "offline");
    frameos_nim_log_hook(log_line);
    frameos_nim_flush_logs();
}

/* Boot-time memory attribution, the C-side companion to the Nim -d:memProbe.
 * Off by default; build with -DFRAMEOS_BOOTMEM=1 to find out which init step
 * is holding the PSRAM a render needs. This is how the 1.57 MB default-font
 * parse was found: every other step on this list costs a couple of KB. */
#if defined(FRAMEOS_BOOTMEM) && FRAMEOS_BOOTMEM
#define BOOTMEM(stage) ESP_LOGW(TAG, "BOOTMEM %-24s psram_free=%u largest=%u internal=%u", \
    stage, (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM), \
    (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_SPIRAM), \
    (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL))
#else
#define BOOTMEM(stage) ((void)0)
#endif

void app_main(void)
{
    const esp_app_desc_t *app = esp_app_get_description();
    const esp_partition_t *running = esp_ota_get_running_partition();
    ESP_LOGI(TAG, "FrameOS %s (idf %s) booting from %s",
             app->version, app->idf_ver, running ? running->label : "?");

    BOOTMEM("start");
    ESP_ERROR_CHECK(fos_config_init());
    fos_config_t *config = fos_config();

    /* Before anything else reads the wake status: was this a button press? */
    fos_buttons_wake_boot();

    fos_battery_init(config->battery_pin, config->battery_divider, config->battery_enable_pin);
    if (fos_battery_present()) {
        int battery_mv = 0, battery_pct = -1;
        fos_battery_read(&battery_mv, &battery_pct);
        ESP_LOGI(TAG, "battery: %d mV (%d%%)", battery_mv, battery_pct);
    }

    /* Not when the battery divider's enable switch sits on the LED pin: the
     * reTerminal E10xx boards switch their divider through GPIO21, and a
     * blinking enable line reads as an empty cell (0 mV, seen on the E1004). */
    if (HEARTBEAT_GPIO >= 0 && config->battery_enable_pin != HEARTBEAT_GPIO) {
        xTaskCreate(heartbeat_task, "heartbeat", 2048, NULL, 2, NULL);
    }

    fos_display_config_t display_config = {
        .panel = config->panel,
        .hardware_preset = config->hardware_preset,
        .rst = config->pins.rst, .dc = config->pins.dc,
        .cs = config->pins.cs, .cs2 = config->pins.cs2,
        .busy = config->pins.busy, .sck = config->pins.sck,
        .mosi = config->pins.mosi, .pwr = config->pins.pwr,
    };
    BOOTMEM("after-config");
    if (fos_display_init(&display_config) != ESP_OK) {
        ESP_LOGW(TAG, "display init failed, continuing headless");
    }

    /* Claim the panel buffer here — the panel size is known and Wi-Fi, lwIP,
     * httpd and SPIFFS have not yet carved up the internal heap. On a
     * PSRAM-less C3 this is the difference between a frame that renders and
     * one that reports "out of memory for 96000 byte framebuffer" with 120 KB
     * free but no block that size. No-op on PSRAM boards. */
    if (fos_display_present()) {
        fos_framebuffer_reserve(fos_display_buffer_size());
        /* The Nim renderer packs into the same reservation (fos_framebuffer.h).
         * The hooks take/return the buffer through the acquire/release pair
         * that fos_client.c already uses to hand it back after the blit. */
        frameos_nim_set_render_buffer_hooks((void *(*)(size_t))fos_framebuffer_acquire,
                                            (void (*)(void *))fos_framebuffer_release);
    }

    /* fos_assets_sd_mount emits its own structured "assets:sd" line into the
     * log ring (and replays it to the backend/cloud once upload is enabled,
     * below) — a mount failure must never be a serial-only event, or "why are
     * my assets empty?" has no remote answer. */
    BOOTMEM("after-display");
    FOS_MEM_LOG_MILESTONE(TAG, "after-display");
    if (fos_assets_sd_mount(config) != ESP_OK) {
        ESP_LOGW(TAG, "SD assets unavailable, continuing without %s: %s",
                 config->assets_path[0] ? config->assets_path : "/srv/assets",
                 fos_assets_sd_last_error());
    } else {
        fos_assets_cleanup_stale_uploads();
    }

    /* Memory guardrail (M4): refuse to render a panel on-device that can't fit
     * the module's PSRAM — it would OOM mid-render. Fall back to thin-client
     * (the backend renders the bitmap) so the frame still works. */
    bool local_render_ok = true;
    if (fos_display_present()) {
        size_t need = fos_display_render_psram_bytes();
        size_t have = heap_caps_get_total_size(MALLOC_CAP_SPIRAM);
        if (have == 0) {
            /* PSRAM-less module (every supported ESP32-C3 board): thin-client
             * is the design, not a degradation — keep the log calm. */
            if (config->render_mode != FOS_RENDER_REMOTE) {
                ESP_LOGI(TAG, "no PSRAM on this module; running as a thin client "
                         "(the backend or cloud renders)");
                config->render_mode = FOS_RENDER_REMOTE;
            }
            local_render_ok = false;
        } else if (need > have) {
            ESP_LOGE(TAG, "panel %s needs ~%u KB PSRAM to render on-device but the module has "
                     "~%u KB; switching to thin-client mode", config->panel,
                     (unsigned)(need / 1024), (unsigned)(have / 1024));
            config->render_mode = FOS_RENDER_REMOTE;
            local_render_ok = false;
        }
    }

    /* The renderer's scene canvas, claimed now for the same reason the thin-
     * client framebuffer was above: it is the one multi-MB contiguous PSRAM
     * run the device needs, and before Wi-Fi/TLS there is always one. */
    if (local_render_ok && frameos_nim_available() && fos_display_present()) {
        frameos_nim_reserve_canvas(fos_display_canvas_bytes());
    }

    BOOTMEM("after-sd");
    ESP_ERROR_CHECK(fos_wifi_init());
    fos_http_set_actions(action_render_now, action_ota_now);

    bool online = false;
    if (fos_config_wifi_ready()) {
        online = fos_wifi_connect(WIFI_CONNECT_TIMEOUT_MS) == ESP_OK;
        if (!online) {
            ESP_LOGW(TAG, "Wi-Fi unreachable; starting provisioning portal");
        }
    } else {
        ESP_LOGI(TAG, "no Wi-Fi configured; starting provisioning portal");
    }

    if (online) {
        fos_wifi_sync_time(SNTP_TIMEOUT_MS);
        /* Network up = this image is good; cancel any pending rollback. */
        fos_ota_mark_boot_valid();
        if (fos_ota_boot_request_pending()) {
            esp_err_t ota_err = fos_ota_run_boot_request();
            if (ota_err != ESP_OK) {
                ESP_LOGW(TAG, "boot OTA request failed: %s", esp_err_to_name(ota_err));
            }
        }
    }

    /* Reserve the large render stack before Nim/QuickJS, SPIFFS and httpd
     * consume internal RAM, but after early-boot OTA had a chance to run with
     * the leanest possible task set. The task waits until fos_client_resume()
     * below, so starting it here only claims the stack. */
    /* Before any render: decides whether the previous boot was a memory
     * rescue and whether rendering should stay paused this time. */
    BOOTMEM("after-wifi");
    FOS_MEM_LOG_MILESTONE(TAG, "after-wifi");
    fos_client_render_recovery_boot();
    fos_client_start();

    BOOTMEM("after-client-start");
    FOS_MEM_LOG_MILESTONE(TAG, "after-client-start");
    if (frameos_nim_available() && local_render_ok) {
        int width = fos_display_present() ? fos_display_width() : 800;
        int height = fos_display_present() ? fos_display_height() : 480;
        char frame_name[64];
        snprintf(frame_name, sizeof(frame_name), "frame %lu", (unsigned long)config->frame_id);
        if (frameos_nim_init(width, height, frame_name, config->max_http_response_bytes,
                             config->backend_url, config->api_key,
                             config->server_send_logs, config->rotate)) {
            ESP_LOGI(TAG, "nim runtime up: %s", frameos_nim_info());
        } else {
            ESP_LOGE(TAG, "nim runtime failed to initialize");
        }
    } else if (frameos_nim_available()) {
        ESP_LOGW(TAG, "nim runtime compiled in but not started (panel too large for PSRAM)");
    } else {
        ESP_LOGI(TAG, "nim runtime not compiled in (thin-client only)");
    }

    /* Interpreted scenes: mount /state and queue any cached scenes.json;
     * the render task applies it and keeps it synced with the backend. */
    BOOTMEM("after-nim-init");

    if (fos_scenes_init() != ESP_OK) {
        ESP_LOGW(TAG, "scene storage unavailable, continuing without");
    }
    BOOTMEM("after-scenes-init");
    /* Needs the Nim runtime (chrono) and /state (the stored slice): from
     * here localtime(), QuickJS Date and the schedule run in the frame's
     * zone. Thin clients stay in UTC. */
    fos_tz_boot();
    fos_schedule_init();

    /* Oversized HTTP bodies (multi-MB gallery images) spill to storage
     * instead of failing on PSRAM pressure (cloud/docs/esp32-large-image-
     * spill.md). Prefer the SD card — a dot-directory stays invisible to the
     * asset API — over the /state SPIFFS partition. Sweep leftovers from a
     * crash before registering. */
    {
        const char *spill_dir = NULL;
        char sd_spill[160];
        /* Extra per-body cap on top of the frame's max_http_response_bytes.
         * SD card: none — the setting alone decides, so a 20 MB gallery JPEG
         * needs nothing but a higher limit. /state (SPIFFS) also holds the
         * scene store: leave headroom for it, and never more than 8 MB. */
        size_t spill_cap = 0;
        if (fos_assets_sd_mounted()) {
            snprintf(sd_spill, sizeof(sd_spill), "%s/.cache",
                     config->assets_path[0] ? config->assets_path : "/srv/assets");
            mkdir(sd_spill, 0775);
            spill_dir = sd_spill;
        } else if (fos_scenes_state_mounted()) {
            size_t state_total = 0, state_used = 0;
            spill_cap = 8 * 1024 * 1024;
            if (esp_spiffs_info("state", &state_total, &state_used) == ESP_OK && state_total > state_used) {
                size_t free_bytes = state_total - state_used;
                size_t margin = 512 * 1024; /* scene updates must still fit */
                size_t usable = free_bytes > margin ? free_bytes - margin : 0;
                if (usable < spill_cap) spill_cap = usable;
            }
            if (spill_cap >= 256 * 1024) {
                spill_dir = "/state";
            } else {
                ESP_LOGW(TAG, "http spill disabled: /state has too little free space");
            }
        }
        if (spill_dir != NULL) {
            DIR *dir = opendir(spill_dir);
            if (dir != NULL) {
                struct dirent *entry;
                while ((entry = readdir(dir)) != NULL) {
                    if (strncmp(entry->d_name, "http-spill-", 11) != 0) continue;
                    char stale[448];
                    snprintf(stale, sizeof(stale), "%s/%s", spill_dir, entry->d_name);
                    unlink(stale);
                    ESP_LOGW(TAG, "removed stale spill file %s", stale);
                }
                closedir(dir);
            }
            fos_nim_http_set_spill_dir(spill_dir, spill_cap);
            fos_nim_http_set_spill_force_bytes(config->http_spill_force_bytes);
            ESP_LOGI(TAG, "http spill dir: %s (cap %u bytes%s)%s", spill_dir,
                     (unsigned)spill_cap, spill_cap ? "" : " = setting only",
                     config->http_spill_force_bytes ? " (forced)" : "");
        }
    }

    BOOTMEM("after-spill");
    fos_console_start();

    /* Cloud-managed frames (docs/cloud-frames.md): idles until cloud_url and
     * a claim token are provisioned (USB `set`, flasher) and Wi-Fi is up,
     * then enrolls and, when enrolled, runs the management WebSocket. */
    BOOTMEM("after-console");
    if (fos_cloud_start() != ESP_OK) {
        ESP_LOGW(TAG, "cloud client unavailable");
    }

    if (online) {
        frameos_nim_set_log_upload_enabled(true);
        if (config->assets_sd.enabled) fos_assets_sd_log_status();
        log_bootup_event(true);
        fos_http_start(false);
        fos_ota_start_periodic_task(24);
        BOOTMEM("after-http+ota");
        FOS_MEM_LOG_MILESTONE(TAG, "after-http+ota");
    } else {
        frameos_nim_set_log_upload_enabled(false);
        if (!fos_config_wifi_ready()) {
            /* Fresh device: nothing to roll back to that would do better. */
            fos_ota_mark_boot_valid();
        }
        /* If Wi-Fi creds exist but fail after an OTA, we deliberately do NOT
         * mark valid: a reset rolls back to the previous image. */
        s_blink_period_ms = 400;
        fos_wifi_start_portal();
        fos_http_start(true);
        fos_status_screen_show_portal(fos_wifi_ap_ssid(), fos_wifi_ip());
    }

    /* Buttons before the render loop: a button wake replays its press into
     * the queue here, and the loop's first pass is what dispatches it. */
    if (fos_buttons_start() != ESP_OK) {
        ESP_LOGW(TAG, "GPIO buttons unavailable");
    }
    /* Render loop runs in both cases: local mode works fully offline. */
    fos_client_resume();

    ESP_LOGI(TAG, "boot complete: wifi=%s ip=%s portal=%s",
             online ? "connected" : "offline", fos_wifi_ip(),
             fos_wifi_state() == FOS_WIFI_PORTAL ? fos_wifi_ap_ssid() : "no");
}

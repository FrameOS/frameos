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
#include <stdio.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "driver/gpio.h"
#include "esp_app_desc.h"
#include "esp_log.h"
#include "esp_ota_ops.h"

#include "fos_client.h"
#include "fos_config.h"
#include "fos_console.h"
#include "fos_http.h"
#include "fos_ota.h"
#include "fos_scenes.h"
#include "fos_wifi.h"
#include "frameos_display.h"
#include "frameos_nim.h"

static const char *TAG = "frameos";

#define WIFI_CONNECT_TIMEOUT_MS 25000
#define SNTP_TIMEOUT_MS 10000

/* Heartbeat on the XIAO ESP32-S3 user LED (GPIO 21, active low). Driving an
 * unconnected GPIO on other boards is harmless. Slow blink = running,
 * fast blink = provisioning portal. */
#define HEARTBEAT_GPIO 21

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

static void ota_task_oneshot(void *arg)
{
    fos_ota_check_and_apply();
    vTaskDelete(NULL);
}

static void action_ota_now(void)
{
    /* Don't block the httpd worker for a whole download. */
    xTaskCreate(ota_task_oneshot, "fos_ota_now", 8192, NULL, 4, NULL);
}

static void action_render_now(void)
{
    fos_client_render_now();
}

void app_main(void)
{
    const esp_app_desc_t *app = esp_app_get_description();
    const esp_partition_t *running = esp_ota_get_running_partition();
    ESP_LOGI(TAG, "FrameOS %s (idf %s) booting from %s",
             app->version, app->idf_ver, running ? running->label : "?");

    ESP_ERROR_CHECK(fos_config_init());
    fos_config_t *config = fos_config();

    xTaskCreate(heartbeat_task, "heartbeat", 2048, NULL, 2, NULL);

    fos_display_config_t display_config = {
        .panel = config->panel,
        .rst = config->pins.rst, .dc = config->pins.dc, .cs = config->pins.cs,
        .busy = config->pins.busy, .sck = config->pins.sck,
        .mosi = config->pins.mosi, .pwr = config->pins.pwr,
    };
    if (fos_display_init(&display_config) != ESP_OK) {
        ESP_LOGW(TAG, "display init failed, continuing headless");
    }

    if (frameos_nim_available()) {
        int width = fos_display_present() ? fos_display_width() : 800;
        int height = fos_display_present() ? fos_display_height() : 480;
        char frame_name[64];
        snprintf(frame_name, sizeof(frame_name), "frame %lu", (unsigned long)config->frame_id);
        if (frameos_nim_init(width, height, frame_name)) {
            ESP_LOGI(TAG, "nim runtime up: %s", frameos_nim_info());
        } else {
            ESP_LOGE(TAG, "nim runtime failed to initialize");
        }
    } else {
        ESP_LOGI(TAG, "nim runtime not compiled in (thin-client only)");
    }

    /* Interpreted scenes (M3): mount /state and queue any cached scenes.json;
     * the render task applies it and keeps it synced with the backend. */
    if (fos_scenes_init() != ESP_OK) {
        ESP_LOGW(TAG, "scene storage unavailable, continuing without");
    }

    ESP_ERROR_CHECK(fos_wifi_init());
    fos_http_set_actions(action_render_now, action_ota_now);
    fos_console_start();

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
        fos_http_start(false);
        fos_ota_start_periodic_task(24);
    } else {
        if (!fos_config_wifi_ready()) {
            /* Fresh device: nothing to roll back to that would do better. */
            fos_ota_mark_boot_valid();
        }
        /* If Wi-Fi creds exist but fail after an OTA, we deliberately do NOT
         * mark valid: a reset rolls back to the previous image. */
        s_blink_period_ms = 400;
        fos_wifi_start_portal();
        fos_http_start(true);
    }

    /* Render loop runs in both cases: local mode works fully offline. */
    fos_client_start();

    ESP_LOGI(TAG, "boot complete: wifi=%s ip=%s portal=%s",
             online ? "connected" : "offline", fos_wifi_ip(),
             fos_wifi_state() == FOS_WIFI_PORTAL ? fos_wifi_ap_ssid() : "no");
}

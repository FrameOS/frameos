/*
 * FrameOS ESP32 stub firmware.
 *
 * Milestone 0: prove the toolchain and the backend build/flash pipeline.
 * Blinks the onboard LED and prints a heartbeat on the USB serial console.
 * No FrameOS runtime yet.
 *
 * Onboard LEDs differ per board, and driving an unconnected GPIO is
 * harmless, so we blink every known candidate rather than guess:
 * - ESP32-S3-DevKitC-1: WS2812 RGB LED on GPIO 48 (rev v1.0) or 38 (v1.1)
 * - Seeed XIAO ESP32-S3: plain user LED on GPIO 21, active low
 */

#include <stdio.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "driver/gpio.h"
#include "esp_log.h"
#include "led_strip.h"

#define FRAMEOS_BLINK_PERIOD_MS 500

static const int BLINK_GPIOS[] = {48, 38};
#define BLINK_GPIO_COUNT (sizeof(BLINK_GPIOS) / sizeof(BLINK_GPIOS[0]))

typedef struct {
    int gpio;
    int active_level;
} plain_led_t;

static const plain_led_t PLAIN_LEDS[] = {
    {.gpio = 21, .active_level = 0}, /* XIAO ESP32-S3 user LED */
};
#define PLAIN_LED_COUNT (sizeof(PLAIN_LEDS) / sizeof(PLAIN_LEDS[0]))

static const char *TAG = "frameos";

static led_strip_handle_t configure_led(int gpio)
{
    led_strip_config_t strip_config = {
        .strip_gpio_num = gpio,
        .max_leds = 1,
    };
    led_strip_rmt_config_t rmt_config = {
        .resolution_hz = 10 * 1000 * 1000, /* 10MHz */
    };
    led_strip_handle_t led_strip;
    ESP_ERROR_CHECK(led_strip_new_rmt_device(&strip_config, &rmt_config, &led_strip));
    return led_strip;
}

void app_main(void)
{
    ESP_LOGI(TAG, "FrameOS ESP32 stub firmware booting");

    led_strip_handle_t led_strips[BLINK_GPIO_COUNT];
    for (size_t i = 0; i < BLINK_GPIO_COUNT; i++) {
        ESP_LOGI(TAG, "Blinking addressable LED on GPIO %d", BLINK_GPIOS[i]);
        led_strips[i] = configure_led(BLINK_GPIOS[i]);
    }
    for (size_t i = 0; i < PLAIN_LED_COUNT; i++) {
        ESP_LOGI(TAG, "Blinking plain LED on GPIO %d (active %d)", PLAIN_LEDS[i].gpio, PLAIN_LEDS[i].active_level);
        gpio_reset_pin(PLAIN_LEDS[i].gpio);
        ESP_ERROR_CHECK(gpio_set_direction(PLAIN_LEDS[i].gpio, GPIO_MODE_OUTPUT));
    }

    bool led_on = false;
    uint32_t beats = 0;

    while (true) {
        led_on = !led_on;
        for (size_t i = 0; i < BLINK_GPIO_COUNT; i++) {
            if (led_on) {
                /* Dim white, easy on the eyes */
                ESP_ERROR_CHECK(led_strip_set_pixel(led_strips[i], 0, 16, 16, 16));
                ESP_ERROR_CHECK(led_strip_refresh(led_strips[i]));
            } else {
                ESP_ERROR_CHECK(led_strip_clear(led_strips[i]));
            }
        }
        for (size_t i = 0; i < PLAIN_LED_COUNT; i++) {
            ESP_ERROR_CHECK(gpio_set_level(PLAIN_LEDS[i].gpio, led_on ? PLAIN_LEDS[i].active_level : !PLAIN_LEDS[i].active_level));
        }
        if (++beats % 20 == 0) {
            ESP_LOGI(TAG, "alive, %lu blinks", (unsigned long)beats);
        }
        vTaskDelay(pdMS_TO_TICKS(FRAMEOS_BLINK_PERIOD_MS));
    }
}

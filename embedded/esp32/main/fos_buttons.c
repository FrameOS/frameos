#include "fos_buttons.h"

#include <stdbool.h>
#include <stdio.h>
#include <string.h>

#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"

#include "driver/gpio.h"
#include "esp_log.h"
#include "esp_timer.h"

#include "fos_client.h"
#include "fos_config.h"
#include "frameos_nim.h"

static const char *TAG = "fos_buttons";

#define BUTTON_QUEUE_LEN 16
#define BUTTON_POLL_MS 20
#define BUTTON_DEBOUNCE_MS 80

typedef struct {
    int pin;
    int level;
    char label[FOS_GPIO_BUTTON_LABEL_LEN];
} fos_button_event_t;

static QueueHandle_t s_queue = NULL;
static bool s_started = false;
static int s_last_level[FOS_GPIO_BUTTONS_MAX];
static int64_t s_last_change_ms[FOS_GPIO_BUTTONS_MAX];
static bool s_press_sent[FOS_GPIO_BUTTONS_MAX];
static bool s_enabled[FOS_GPIO_BUTTONS_MAX];

static void json_escape(const char *src, char *dst, size_t dst_len)
{
    if (!dst_len) return;
    size_t out = 0;
    for (size_t in = 0; src[in] && out + 1 < dst_len; in++) {
        char c = src[in];
        if ((c == '"' || c == '\\') && out + 2 < dst_len) {
            dst[out++] = '\\';
            dst[out++] = c;
        } else if ((unsigned char)c >= 0x20) {
            dst[out++] = c;
        }
    }
    dst[out] = '\0';
}

static void enqueue_press(const fos_gpio_button_t *button, int level)
{
    if (!s_queue) return;
    fos_button_event_t event = {
        .pin = button->pin,
        .level = level,
    };
    strlcpy(event.label, button->label, sizeof(event.label));
    if (xQueueSend(s_queue, &event, 0) != pdTRUE) {
        ESP_LOGW(TAG, "button event queue full, dropping GPIO %d", button->pin);
        return;
    }
    fos_client_render_now();
}

static void buttons_task(void *arg)
{
    fos_config_t *config = fos_config();
    for (size_t i = 0; i < config->gpio_button_count; i++) {
        if (!s_enabled[i]) continue;
        s_last_level[i] = gpio_get_level(config->gpio_buttons[i].pin);
        s_last_change_ms[i] = esp_timer_get_time() / 1000;
        s_press_sent[i] = s_last_level[i] == 0;
    }

    while (true) {
        int64_t now_ms = esp_timer_get_time() / 1000;
        for (size_t i = 0; i < config->gpio_button_count; i++) {
            if (!s_enabled[i]) continue;
            const fos_gpio_button_t *button = &config->gpio_buttons[i];
            int level = gpio_get_level(button->pin);
            if (level != s_last_level[i]) {
                s_last_level[i] = level;
                s_last_change_ms[i] = now_ms;
            }
            if (now_ms - s_last_change_ms[i] < BUTTON_DEBOUNCE_MS) {
                continue;
            }
            if (level == 0 && !s_press_sent[i]) {
                s_press_sent[i] = true;
                enqueue_press(button, level);
            } else if (level != 0) {
                s_press_sent[i] = false;
            }
        }
        vTaskDelay(pdMS_TO_TICKS(BUTTON_POLL_MS));
    }
}

esp_err_t fos_buttons_start(void)
{
    if (s_started) return ESP_OK;
    fos_config_t *config = fos_config();
    if (config->gpio_button_count == 0) {
        ESP_LOGI(TAG, "no GPIO buttons configured");
        return ESP_OK;
    }

    s_queue = xQueueCreate(BUTTON_QUEUE_LEN, sizeof(fos_button_event_t));
    if (!s_queue) {
        return ESP_ERR_NO_MEM;
    }

    bool any_enabled = false;
    for (size_t i = 0; i < config->gpio_button_count; i++) {
        s_enabled[i] = false;
        const fos_gpio_button_t *button = &config->gpio_buttons[i];
        gpio_config_t gpio = {
            .pin_bit_mask = 1ULL << button->pin,
            .mode = GPIO_MODE_INPUT,
            .pull_up_en = GPIO_PULLUP_ENABLE,
            .pull_down_en = GPIO_PULLDOWN_DISABLE,
            .intr_type = GPIO_INTR_DISABLE,
        };
        esp_err_t err = gpio_config(&gpio);
        if (err != ESP_OK) {
            ESP_LOGW(TAG, "GPIO %d (%s) config failed: %s", button->pin, button->label, esp_err_to_name(err));
            continue;
        }
        s_enabled[i] = true;
        any_enabled = true;
        ESP_LOGI(TAG, "listening on GPIO %d (%s)", button->pin, button->label);
    }
    if (!any_enabled) {
        vQueueDelete(s_queue);
        s_queue = NULL;
        return ESP_ERR_INVALID_STATE;
    }

    BaseType_t created = xTaskCreate(buttons_task, "fos_buttons", 3072, NULL, 4, NULL);
    if (created != pdPASS) {
        vQueueDelete(s_queue);
        s_queue = NULL;
        return ESP_ERR_NO_MEM;
    }
    s_started = true;
    return ESP_OK;
}

void fos_buttons_process_events(void)
{
    if (!s_queue) return;

    fos_button_event_t event;
    while (xQueueReceive(s_queue, &event, 0) == pdTRUE) {
        char label[sizeof(event.label) * 2];
        json_escape(event.label, label, sizeof(label));
        char payload[96];
        snprintf(payload, sizeof(payload), "{\"pin\":%d,\"label\":\"%s\",\"level\":%d}",
                 event.pin, label, event.level);
        if (!frameos_nim_send_event("button", payload)) {
            ESP_LOGW(TAG, "button event skipped: Nim runtime unavailable");
        }
    }
}

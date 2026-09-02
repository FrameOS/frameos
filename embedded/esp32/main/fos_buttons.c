#include "fos_buttons.h"

#include <stdbool.h>
#include <stdio.h>
#include <string.h>

#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"

#include "driver/gpio.h"
#include "esp_log.h"
#include "esp_sleep.h"
#include "esp_timer.h"
#include "soc/soc_caps.h"
#if SOC_PM_SUPPORT_EXT1_WAKEUP
#include "driver/rtc_io.h"
#endif

#include "fos_client.h"
#include "fos_config.h"
#include "fos_wake.h"
#include "frameos_nim.h"

static const char *TAG = "fos_buttons";

#define BUTTON_QUEUE_LEN 16
#define BUTTON_POLL_MS 20
#define BUTTON_DEBOUNCE_MS 80

typedef struct {
    int pin;
    int level;
    bool wake; /* the press that woke the chip from deep sleep, replayed */
    char label[FOS_GPIO_BUTTON_LABEL_LEN];
} fos_button_event_t;

static QueueHandle_t s_queue = NULL;
static bool s_started = false;
/* This boot's wake, when a button caused it (fos_buttons_wake_boot). */
static int s_wake_pin = -1;
static char s_wake_label[FOS_GPIO_BUTTON_LABEL_LEN] = "";
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

static void enqueue_event(const fos_gpio_button_t *button, int level, bool wake)
{
    if (!s_queue) return;
    fos_button_event_t event = {
        .pin = button->pin,
        .level = level,
        .wake = wake,
    };
    strlcpy(event.label, button->label, sizeof(event.label));
    if (xQueueSend(s_queue, &event, 0) != pdTRUE) {
        ESP_LOGW(TAG, "button event queue full, dropping GPIO %d", button->pin);
        char dropped[160];
        snprintf(dropped, sizeof(dropped),
                 "{\"event\":\"button:dropped\",\"source\":\"esp32\",\"pin\":%d,"
                 "\"reason\":\"queue-full\"}", button->pin);
        frameos_nim_log_hook(dropped);
        return;
    }
    /* A live press asks for a render pass. The replayed wake press does not:
     * the boot's first pass renders anyway (fos_buttons_woke_by_button), and
     * a stale RENDER_NOW would replay the same frame right after it. */
    if (!wake) fos_client_render_now();
}

static void enqueue_press(const fos_gpio_button_t *button, int level)
{
    enqueue_event(button, level, false);
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
        /* A stored spec from before the parser refused these (or a pin a
         * driver has since claimed): configuring a pull-up on a flash pad
         * here is what turns a bad setting into a boot loop. Skip, say so. */
        const char *reserved = fos_config_gpio_pin_reserved(button->pin);
        if (reserved != NULL) {
            ESP_LOGW(TAG, "GPIO %d (%s) skipped: %s", button->pin, button->label, reserved);
            continue;
        }
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

    /* One line naming the pins and labels this frame is listening on. Half of
     * "I pressed the button and nothing happened" is not knowing which pin the
     * board actually wired, and which label a scene has to match. */
    {
        char list[352];
        size_t used = 0;
        list[0] = '\0';
        for (size_t i = 0; i < config->gpio_button_count && used + 1 < sizeof(list); i++) {
            if (!s_enabled[i]) continue;
            char label[FOS_GPIO_BUTTON_LABEL_LEN * 2];
            json_escape(config->gpio_buttons[i].label, label, sizeof(label));
            int written = snprintf(list + used, sizeof(list) - used,
                                   "%s{\"pin\":%d,\"label\":\"%s\",\"wake\":%s}",
                                   used ? "," : "", config->gpio_buttons[i].pin, label,
                                   fos_buttons_pin_can_wake(config->gpio_buttons[i].pin) ? "true" : "false");
            if (written < 0 || (size_t)written >= sizeof(list) - used) break;
            used += (size_t)written;
        }
        char line[416];
        snprintf(line, sizeof(line),
                 "{\"event\":\"buttons:listening\",\"source\":\"esp32\",\"buttons\":[%s]}",
                 list);
        frameos_nim_log_hook(line);
    }

    /* This boot is a button wake: replay the press so the scene sees it. The
     * key was released seconds ago (Wi-Fi, TLS, scene load all came first),
     * so the poll loop below has no edge to detect. Queued now, dispatched
     * on the render task's first pass once the scene is resident. */
    if (s_wake_pin >= 0) {
        for (size_t i = 0; i < config->gpio_button_count; i++) {
            if (!s_enabled[i] || config->gpio_buttons[i].pin != s_wake_pin) continue;
            enqueue_event(&config->gpio_buttons[i], 0, true);
            break;
        }
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
        bool dispatched = frameos_nim_send_event("button", payload);
        /* Into the frame log, not just the serial console: a press used to
         * leave no trace anywhere a user can see. When a scene ignores it the
         * interpreter says so (runEvent:noListenerMatched), but that only
         * helps if you can first tell the press was registered at all. */
        char line[224];
        snprintf(line, sizeof(line),
                 "{\"event\":\"button\",\"source\":\"esp32\",\"pin\":%d,"
                 "\"label\":\"%s\",\"level\":%d,\"dispatched\":%s,\"wake\":%s}",
                 event.pin, label, event.level, dispatched ? "true" : "false",
                 event.wake ? "true" : "false");
        frameos_nim_log_hook(line);
        if (!dispatched) {
            ESP_LOGW(TAG, "button event skipped: Nim runtime unavailable");
        }
    }
}

/* ------------------------------------------------------- deep-sleep wake */

/* The chip's wake-capable pin set, as a GPIO bit mask. */
static uint64_t wake_valid_mask(void)
{
#if SOC_PM_SUPPORT_EXT1_WAKEUP
    /* ext1 monitors RTC IOs only (GPIO0-21 on the S3). */
    uint64_t mask = 0;
    for (int pin = 0; pin < SOC_GPIO_PIN_COUNT && pin < 64; pin++) {
        if (rtc_gpio_is_valid_gpio((gpio_num_t)pin)) mask |= 1ULL << pin;
    }
    return mask;
#elif SOC_GPIO_SUPPORT_DEEPSLEEP_WAKEUP
    return SOC_GPIO_DEEP_SLEEP_WAKE_VALID_GPIO_MASK; /* GPIO0-5 on the C3 */
#else
    return 0;
#endif
}

static void button_pins(const fos_config_t *config, int *pins, size_t *count)
{
    size_t n = 0;
    for (size_t i = 0; i < config->gpio_button_count && n < FOS_GPIO_BUTTONS_MAX; i++) {
        pins[n++] = config->gpio_buttons[i].pin;
    }
    *count = n;
}

bool fos_buttons_pin_can_wake(int pin)
{
    if (pin < 0 || pin > 63) return false;
    return (wake_valid_mask() & (1ULL << pin)) != 0;
}

void fos_buttons_wake_boot(void)
{
    uint64_t status = 0;
    esp_sleep_wakeup_cause_t cause = esp_sleep_get_wakeup_cause();
#if SOC_PM_SUPPORT_EXT1_WAKEUP
    if (cause == ESP_SLEEP_WAKEUP_EXT1) status = esp_sleep_get_ext1_wakeup_status();
#endif
#if SOC_GPIO_SUPPORT_DEEPSLEEP_WAKEUP
    if (cause == ESP_SLEEP_WAKEUP_GPIO) status = esp_sleep_get_gpio_wakeup_status();
#endif
    if (status == 0) return;

    fos_config_t *config = fos_config();
    int pins[FOS_GPIO_BUTTONS_MAX];
    size_t count = 0;
    button_pins(config, pins, &count);
    int index = fos_wake_button_index(pins, count, status);
    if (index < 0) {
        ESP_LOGW(TAG, "woke from deep sleep on GPIO mask 0x%llx, but no button owns it",
                 (unsigned long long)status);
        return;
    }
    s_wake_pin = config->gpio_buttons[index].pin;
    strlcpy(s_wake_label, config->gpio_buttons[index].label, sizeof(s_wake_label));
    /* printf: INFO is compiled out, and this is the one line that explains an
     * off-schedule boot on the USB console. */
    printf("woke from deep sleep: button GPIO %d (%s)\n", s_wake_pin, s_wake_label);
}

bool fos_buttons_woke_by_button(int *pin, char *label, size_t label_len)
{
    if (s_wake_pin < 0) return false;
    if (pin) *pin = s_wake_pin;
    if (label && label_len) strlcpy(label, s_wake_label, label_len);
    return true;
}

esp_err_t fos_buttons_arm_wake(uint64_t *armed_mask)
{
    if (armed_mask) *armed_mask = 0;
    fos_config_t *config = fos_config();
    int pins[FOS_GPIO_BUTTONS_MAX];
    size_t count = 0;
    button_pins(config, pins, &count);
    if (count == 0) return ESP_OK;

    /* A key held down right now would wake the chip the instant it sleeps
     * (any-low), and keep doing so for as long as the finger stays: a
     * render-sleep-render loop on a battery. Held keys sit this sleep out. */
    uint64_t held = 0;
    for (size_t i = 0; i < count; i++) {
        if (pins[i] >= 0 && pins[i] < 64 && gpio_get_level(pins[i]) == 0) {
            held |= 1ULL << pins[i];
        }
    }
    /* Pins fos_buttons_start refused are not wake sources either. */
    uint64_t valid = wake_valid_mask();
    for (size_t i = 0; i < count; i++) {
        if (pins[i] >= 0 && pins[i] < 64 && fos_config_gpio_pin_reserved(pins[i]) != NULL) {
            valid &= ~(1ULL << pins[i]);
        }
    }
    uint64_t skipped = 0;
    uint64_t mask = fos_wake_button_mask(pins, count, valid, held, &skipped);
    if (skipped != 0) {
        ESP_LOGW(TAG, "buttons not armed for wake (not wake-capable or held): GPIO mask 0x%llx",
                 (unsigned long long)skipped);
    }
    if (mask == 0) return ESP_OK;

    esp_err_t err = ESP_ERR_NOT_SUPPORTED;
#if SOC_PM_SUPPORT_EXT1_WAKEUP
    /* The buttons rely on internal pull-ups (no board here has external
     * ones), and those live in the RTC_PERIPH domain: keep it powered, and
     * set the RTC-side pulls so the pads stay high while the digital domain
     * is off. Straight from the IDF deep_sleep example's ext1 branch. Costs a
     * few µA of sleep current, which a single skipped wake repays. */
    esp_sleep_pd_config(ESP_PD_DOMAIN_RTC_PERIPH, ESP_PD_OPTION_ON);
    for (int pin = 0; pin < 64; pin++) {
        if ((mask & (1ULL << pin)) == 0) continue;
        rtc_gpio_pulldown_dis((gpio_num_t)pin);
        rtc_gpio_pullup_en((gpio_num_t)pin);
    }
    err = esp_sleep_enable_ext1_wakeup(mask, ESP_EXT1_WAKEUP_ANY_LOW);
#elif SOC_GPIO_SUPPORT_DEEPSLEEP_WAKEUP
    /* C3: the driver sets the internal pull-ups itself
     * (ESP_SLEEP_GPIO_ENABLE_INTERNAL_RESISTORS, on by default). */
    err = esp_deep_sleep_enable_gpio_wakeup(mask, ESP_GPIO_WAKEUP_GPIO_LOW);
#endif
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "arming button wake failed: %s", esp_err_to_name(err));
        return err;
    }
    if (armed_mask) *armed_mask = mask;
    return ESP_OK;
}

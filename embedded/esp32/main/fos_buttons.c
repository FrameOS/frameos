#include "fos_buttons.h"
#include "fos_button_timing.h"

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

#include "fos_buzzer.h"
#include "fos_client.h"
#include "fos_config.h"
#include "fos_events.h"
#include "fos_events_gen.h"
#include "fos_wake.h"
#include "frameos_nim.h"

static const char *TAG = "fos_buttons";

/* Edges, not presses: a press and its release take two. The render task
 * drains the queue only between passes, so this is how many edges a render
 * can sit on — an E1004 refresh is ~30 s. At 16 the ninth press of a burst
 * was dropped; 64 keeps 32 presses. Items are 8 bytes (the label is read
 * from the config when the event is delivered): 512 bytes of internal RAM. */
#define BUTTON_QUEUE_LEN 64
/* The debounce (a lockout after each accepted edge) and the press kinds the
 * buzzer sounds are fos_button_timing.c's, on the contract's numbers. */
#define BUTTON_POLL_MS 20

typedef struct {
    uint8_t index; /* into config->gpio_buttons, which only a restart rebinds */
    uint8_t level; /* 0: pressed (the line is pulled up), 1: released */
    bool wake;     /* the down that woke the chip from deep sleep, stamped at boot */
    /* When this task saw the edge, ms since boot (esp_timer), low 32 bits:
     * the dispatcher measures the hold and the double-press window from it,
     * not from when the render task got round to the queue. Widened back to
     * 64 bits on delivery (fos_wake_edge_at_ms), so it wraps only for an edge
     * that sat in the queue for 49 days. */
    uint32_t at_ms;
} fos_button_event_t;

static QueueHandle_t s_queue = NULL;
static bool s_started = false;
/* This boot's wake, when a button caused it (fos_buttons_wake_boot). */
static int s_wake_pin = -1;
static char s_wake_label[FOS_GPIO_BUTTON_LABEL_LEN] = "";
static uint64_t s_wake_mask = 0;
/* Each key's debounce and press kinds (fos_button_timing.h): `down` is
 * "a press was accepted, or the key was down at boot". */
static fos_button_timing_t s_timing[FOS_GPIO_BUTTONS_MAX];
/* The press is in the queue (or the key was held at boot): its release has a
 * slot reserved and must follow, or the dispatcher would hold the key forever
 * and its `up` would never decide anything. */
static bool s_release_owed[FOS_GPIO_BUTTONS_MAX];
/* What this key's press clicked, so the hold and the release sound to
 * match: nothing (held at boot, or no buzzer), a press, the second press of
 * a double press, or a refused press. */
typedef enum { CLICK_NONE = 0, CLICK_PRESS, CLICK_DOUBLE, CLICK_REFUSED } click_t;
static click_t s_clicked[FOS_GPIO_BUTTONS_MAX];
/* The dispatcher still has a `press`, `doublePress` or `longPress` to
 * deliver for this key (fos_button_timing_busy, 100 ms of slack for the tick
 * that delivers it). Written by the button task each poll, read by the render
 * task (fos_buttons_busy): a bool, so no torn read. */
static volatile bool s_busy[FOS_GPIO_BUTTONS_MAX];
#define BUTTON_BUSY_SLACK_MS 100
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

static void log_dropped(int pin)
{
    ESP_LOGW(TAG, "button event queue full, dropping GPIO %d", pin);
    char dropped[160];
    snprintf(dropped, sizeof(dropped),
             "{\"event\":\"button:dropped\",\"source\":\"esp32\",\"pin\":%d,"
             "\"reason\":\"queue-full\"}", pin);
    frameos_nim_log_hook(dropped);
}

static int64_t now_ms(void)
{
    return esp_timer_get_time() / 1000;
}

static bool enqueue_event(size_t index, int level, bool wake, int64_t at_ms)
{
    if (!s_queue) return false;
    fos_button_event_t event = {
        .index = (uint8_t)index,
        .level = (uint8_t)(level != 0),
        .wake = wake,
        .at_ms = (uint32_t)at_ms,
    };
    if (xQueueSend(s_queue, &event, 0) != pdTRUE) {
        log_dropped(fos_config()->gpio_buttons[index].pin);
        return false;
    }
    /* A live press wakes the render task so the scene hears it now, not at the
     * end of a wait slice — and that is all. Whether a frame is drawn is the
     * runtime's call: it asks for one when a listener took the press or the
     * scene dispatched "render" (frameos_nim_render_requested). This used to be
     * fos_client_render_now(), which refreshed the panel for every press,
     * heard or not. The replayed wake press needs no nudge: the boot's first
     * pass processes the queue anyway (fos_buttons_woke_by_button). */
    if (!wake) fos_client_wake_for_events();
    return true;
}

/* Releases this task still owes the queue: each has a slot reserved. */
static size_t releases_owed(size_t count)
{
    size_t owed = 0;
    for (size_t i = 0; i < count; i++) {
        if (s_release_owed[i]) owed++;
    }
    return owed;
}

static void press_edge(size_t index, size_t count, int64_t at_ms)
{
    /* Room for the press AND its release, on top of the releases already
     * owed: an accepted press is always followed by its release. Only this
     * task sends (the render task only takes), so the reservation holds. */
    /* Book it either way: the hold is timed from here. A refused press is
     * one the dispatcher never hears, so it pairs with nothing (below). */
    bool twice = fos_button_timing_press(&s_timing[index], at_ms);
    if (uxQueueSpacesAvailable(s_queue) < releases_owed(count) + 2) {
        /* Not received: say so with the dull click instead of the bright one. */
        log_dropped(fos_config()->gpio_buttons[index].pin);
        s_clicked[index] = CLICK_REFUSED;
        s_timing[index].twice = false;
        fos_buzzer_reject_down();
        return;
    }
    if (!enqueue_event(index, 0, false, at_ms)) {
        s_clicked[index] = CLICK_NONE;
        s_timing[index].twice = false;
        return;
    }
    s_release_owed[index] = true;
    /* Registered: click now, from this task, so the feedback does not wait
     * for the render task (which may be 30 s into a panel refresh). A `down`
     * clicks; the second down of a double press (the dispatcher makes it a
     * `doublePress`, by the same rule on the same stamps) clicks higher.
     * Every `up` is the same lower click. A held key sounds each second
     * (hold_sounds); the `press` a short tap becomes 350 ms after its `up`
     * adds no sound: its clicks were the down and the up. */
    s_clicked[index] = twice ? CLICK_DOUBLE : CLICK_PRESS;
    if (twice) fos_buzzer_double_down();
    else fos_buzzer_click_down();
}

/* A key still down: the long-press sound at every whole longPressMs held
 * (1 s, 2 s, ...), counting the hold out loud, the key that woke the chip
 * too (counted from its wake click). The scene hears its `longPress` once,
 * with the `up`; this says "it is one now, and still going". Not for the
 * second press of a double press: no long press comes of it. */
static void hold_sounds(size_t index, int64_t now_ms)
{
    if (!fos_button_timing_hold_tick(&s_timing[index], now_ms)) return;
    if (s_clicked[index] != CLICK_PRESS) return;
    fos_buzzer_long_press();
}

static void release_edge(size_t index, int64_t at_ms)
{
    fos_button_timing_release(&s_timing[index], at_ms, NULL);
    click_t clicked = s_clicked[index];
    /* Only a press the dispatcher heard as one can start a double press:
     * not a refused one, not a key down since boot. The wake press is one. */
    if (clicked != CLICK_PRESS && clicked != CLICK_DOUBLE) {
        s_timing[index].tap_ended = false;
    }
    if (s_release_owed[index]) {
        enqueue_event(index, 1, false, at_ms); /* its slot was reserved */
        s_release_owed[index] = false;
    }
    s_clicked[index] = CLICK_NONE;
    /* Every up is the same lower click: a tap's, a double press's, a long
     * press's (its seconds were sounded while it was held). */
    if (clicked == CLICK_PRESS || clicked == CLICK_DOUBLE) fos_buzzer_click_up();
    else if (clicked == CLICK_REFUSED) fos_buzzer_reject_up();
}

static void buttons_task(void *arg)
{
    fos_config_t *config = fos_config();
    for (size_t i = 0; i < config->gpio_button_count; i++) {
        if (!s_enabled[i]) continue;
        int level = gpio_get_level(config->gpio_buttons[i].pin);
        fos_button_timing_init(&s_timing[i], level, now_ms());
        /* Held at boot: no press was queued, but its release is real. */
        s_release_owed[i] = s_timing[i].down;
        s_clicked[i] = CLICK_NONE;
        if (config->gpio_buttons[i].pin != s_wake_pin) continue;
        /* The key that woke the chip: its down clicked at boot
         * (fos_buttons_wake_boot), and from here on it is a press like any
         * other, so holding it is a long press and a quick second tap a
         * double press. The chip cannot see a key while it boots (0.75 s on
         * the E1002, most of it the bootloader checking the app), so the
         * first look decides the stamps:
         * - still down: the press began at the reset (esp_timer 0), so the
         *   hold counts from there: its duns, and the `longPress` its `up`
         *   makes, match the hold the finger made;
         * - already up: a tap. Its `down` and `up` are stamped now, when they
         *   were first seen, so the double-press window opens now and a
         *   second tap within doublePressMs pairs with it. A second tap made
         *   and let go entirely during the boot is not seen. */
        if (s_timing[i].down) {
            s_clicked[i] = CLICK_PRESS;
            s_timing[i].pressed_at_ms = 0;
            enqueue_event(i, 0, true, 0);
        } else {
            int64_t seen_ms = now_ms();
            enqueue_event(i, 0, true, seen_ms);
            fos_button_timing_press(&s_timing[i], seen_ms);
            s_release_owed[i] = true;
            s_clicked[i] = CLICK_PRESS;
            release_edge(i, seen_ms);
        }
    }

    while (true) {
        int64_t now = now_ms();
        for (size_t i = 0; i < config->gpio_button_count; i++) {
            if (!s_enabled[i]) continue;
            const fos_gpio_button_t *button = &config->gpio_buttons[i];
            /* Both edges, as `down` and `up`: the hardware layer a scene can
             * hear as it is, and what the Nim dispatcher makes `press`,
             * `doublePress` and `longPress` out of (frameos/input_state.nim),
             * the same on every host. The first change of level is the edge, stamped with
             * the poll that saw it, and bounce after it is locked out
             * (fos_button_timing_sample): a 20 ms tap is a tap, and a tap
             * made while the render task is 30 s into a refresh is still a
             * tap when the queue is drained. */
            switch (fos_button_timing_sample(&s_timing[i], gpio_get_level(button->pin), now)) {
            case FOS_BUTTON_EDGE_PRESS:
                press_edge(i, config->gpio_button_count, now);
                break;
            case FOS_BUTTON_EDGE_RELEASE:
                /* A key held at boot is `down` already: its release is real. */
                if (s_timing[i].down) release_edge(i, now);
                break;
            default:
                if (s_timing[i].down) hold_sounds(i, now);
                break;
            }
            s_busy[i] = fos_button_timing_busy(&s_timing[i], now, BUTTON_BUSY_SLACK_MS);
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

    const fos_config_t *config = fos_config();
    fos_button_event_t event;
    while (xQueueReceive(s_queue, &event, 0) == pdTRUE) {
        if (event.index >= config->gpio_button_count) continue;
        const fos_gpio_button_t *button = &config->gpio_buttons[event.index];
        char label[FOS_GPIO_BUTTON_LABEL_LEN * 2];
        json_escape(button->label, label, sizeof(label));
        /* A `gpio` edge and when it was seen, nothing more: `action` is
         * `down` or `up`, `wake` whether it booted the chip, `atMs` the button
         * task's clock (esp_timer, the CLOCK_MONOTONIC the Nim side reads
         * too). The role, the `up`'s `durationMs` and the `button` the edges
         * add up to (`press`, `doublePress`, `longPress`) are the Nim
         * dispatcher's (input_state.nim), timed from `atMs`. */
        char payload[224];
        snprintf(payload, sizeof(payload),
                 "{\"pin\":%d,\"label\":\"%s\",\"level\":%d,\"action\":\"%s\"%s,\"atMs\":%lld}",
                 button->pin, label, event.level,
                 event.level == 0 ? FOS_GPIO_ACTION_DOWN : FOS_GPIO_ACTION_UP,
                 event.wake ? ",\"wake\":true" : "",
                 (long long)fos_wake_edge_at_ms(event.at_ms, now_ms()));
        /* `driver`: a press is hardware talking, and the contract lets it say
         * input and nothing else. fos_events.c hands it to the scene and asks
         * for the render when a listener took it; this is the render task, so
         * the runtime lock is free. */
        bool dispatched = fos_events_dispatch(FOS_ORIGIN_DRIVER, FOS_EVENT_GPIO, payload) == FOS_EVENT_DONE;
        /* Into the frame log, not just the serial console: a press used to
         * leave no trace anywhere a user can see. When a scene ignores it the
         * interpreter says so (runEvent:noListenerMatched), but that only
         * helps if you can first tell the press was registered at all. */
        char line[256];
        snprintf(line, sizeof(line),
                 "{\"event\":\"gpio\",\"source\":\"esp32\",\"pin\":%d,"
                 "\"label\":\"%s\",\"level\":%d,\"action\":\"%s\",\"dispatched\":%s,\"wake\":%s}",
                 button->pin, label, event.level,
                 event.level == 0 ? FOS_GPIO_ACTION_DOWN : FOS_GPIO_ACTION_UP,
                 dispatched ? "true" : "false", event.wake ? "true" : "false");
        frameos_nim_log_hook(line);
        /* `dispatched` is whether a listener heard the edge or the `button`
         * it made: a scene that listens only for presses hears nothing on a
         * first `down`. A runtime that is not up says so itself. */
        if (!dispatched) {
            ESP_LOGD(TAG, "gpio edge: no listener heard it");
        }
    }
    /* Time passing: a key still held is a `longPress` each second, a short
     * press whose double-press window closed a `press`. This runs on the render task's wait slices, so a
     * long press lands while the finger is still down. */
    if (frameos_nim_tick()) {
        fos_client_wake_for_events();
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
    s_wake_mask = status;

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
    /* The press that woke a sleeping frame clicks down at boot, the same
     * click as any press: the scene hears it only once Wi-Fi and the scene
     * are up, seconds later. The button task (started right after this)
     * follows the hold and clicks up on the release. */
    fos_buzzer_click_down();
    /* printf: INFO is compiled out, and this is the one line that explains an
     * off-schedule boot on the USB console. */
    printf("woke from deep sleep: button GPIO %d (%s)\n", s_wake_pin, s_wake_label);
}

uint64_t fos_buttons_wake_mask(void)
{
    return s_wake_mask;
}

bool fos_buttons_busy(void)
{
    if (!s_started) return false;
    for (size_t i = 0; i < FOS_GPIO_BUTTONS_MAX; i++) {
        if (s_busy[i]) return true;
    }
    return false;
}

bool fos_buttons_pending(void)
{
    return s_queue != NULL && uxQueueMessagesWaiting(s_queue) > 0;
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

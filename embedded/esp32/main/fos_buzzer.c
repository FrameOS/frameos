#include "fos_buzzer.h"

#include <stdbool.h>
#include <stdio.h>

#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

#include "driver/gpio.h"
#include "driver/ledc.h"
#include "esp_log.h"
#include "esp_timer.h"

#include "fos_config.h"

static const char *TAG = "fos_buzzer";

/* Nothing else in the firmware uses LEDC. Take the last timer and channel
 * (the C3 has six channels, the S3 eight) so a future user counting from 0
 * does not land on the buzzer. */
#define BUZZER_MODE LEDC_LOW_SPEED_MODE
#define BUZZER_TIMER ((ledc_timer_t)(LEDC_TIMER_MAX - 1))
#define BUZZER_CHANNEL ((ledc_channel_t)(LEDC_CHANNEL_MAX - 1))
#define BUZZER_RESOLUTION LEDC_TIMER_10_BIT
#define BUZZER_HALF_DUTY (1u << (BUZZER_RESOLUTION - 1))

/* The LEDC timer's first frequency; every tone sets its own. */
#define TIMER_START_HZ 2000
#define CHIRP_MS 60
/* A refused press: a quarter of the press tone, so it reads as "no" next to
 * the press's "yes" whatever pitch the frame is set to. */
#define REJECT_MS 50
#define REJECT_MIN_HZ 150

static SemaphoreHandle_t s_lock = NULL;
static esp_timer_handle_t s_stop_timer = NULL;
static bool s_timer_ready = false;
static uint32_t s_freq_hz = 0;
static int s_pin = -1;         /* the pin the channel drives, -1 = none */
static int s_refused_pin = -1; /* said why once; quiet until the pin changes */

/* A pin the board already uses for something else: a PWM on a button's
 * pull-up or the panel's SPI lines would break the thing it shares with.
 * The setters only check the chip's reserved pads; this catches the rest. */
static const char *pin_conflict(const fos_config_t *config, int pin)
{
    const char *reserved = fos_config_gpio_pin_reserved(pin);
    if (reserved != NULL) return reserved;
    const fos_pins_t *p = &config->pins;
    if (pin == p->rst || pin == p->dc || pin == p->cs || pin == p->cs2 || pin == p->busy ||
        pin == p->sck || pin == p->mosi || pin == p->pwr) {
        return "a display pin";
    }
    for (size_t i = 0; i < config->gpio_button_count; i++) {
        if (config->gpio_buttons[i].pin == pin) return "a button";
    }
    if (pin == config->battery_pin || pin == config->battery_enable_pin) return "a battery pin";
    if (config->assets_sd.enabled &&
        (pin == config->assets_sd.cs || pin == config->assets_sd.sck ||
         pin == config->assets_sd.miso || pin == config->assets_sd.mosi)) {
        return "an SD card pin";
    }
    return NULL;
}

/* Point the channel at `pin`, letting go of the previous one. Under s_lock.
 * True when there is a buzzer to drive. */
static bool attach(int pin)
{
    if (pin == s_pin) return s_pin >= 0;
    if (s_pin >= 0) {
        ledc_stop(BUZZER_MODE, BUZZER_CHANNEL, 0);
        gpio_reset_pin((gpio_num_t)s_pin);
        s_pin = -1;
    }
    if (pin < 0) {
        s_refused_pin = -1;
        return false;
    }

    const char *conflict = pin_conflict(fos_config(), pin);
    if (conflict != NULL) {
        if (s_refused_pin != pin) {
            s_refused_pin = pin;
            /* printf: INFO and WARN-only builds alike show it on the console. */
            printf("buzzer: GPIO %d not used, it is %s\n", pin, conflict);
        }
        return false;
    }

    if (!s_timer_ready) {
        ledc_timer_config_t timer = {
            .speed_mode = BUZZER_MODE,
            .duty_resolution = BUZZER_RESOLUTION,
            .timer_num = BUZZER_TIMER,
            .freq_hz = TIMER_START_HZ,
            .clk_cfg = LEDC_AUTO_CLK,
        };
        esp_err_t err = ledc_timer_config(&timer);
        if (err != ESP_OK) {
            ESP_LOGW(TAG, "LEDC timer: %s", esp_err_to_name(err));
            return false;
        }
        s_timer_ready = true;
        s_freq_hz = TIMER_START_HZ;
    }
    ledc_channel_config_t channel = {
        .gpio_num = pin,
        .speed_mode = BUZZER_MODE,
        .channel = BUZZER_CHANNEL,
        .intr_type = LEDC_INTR_DISABLE,
        .timer_sel = BUZZER_TIMER,
        .duty = 0,
        .hpoint = 0,
    };
    esp_err_t err = ledc_channel_config(&channel);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "LEDC channel on GPIO %d: %s", pin, esp_err_to_name(err));
        return false;
    }
    /* Idle low between tones: no DC through the transducer. */
    ledc_stop(BUZZER_MODE, BUZZER_CHANNEL, 0);
    s_pin = pin;
    s_refused_pin = -1;
    return true;
}

static void stop_tone(void *arg)
{
    (void)arg;
    xSemaphoreTake(s_lock, portMAX_DELAY);
    /* Active again: a new tone restarted the timer while this callback
     * waited for the lock, and that tone is not over yet. */
    if (s_pin >= 0 && !esp_timer_is_active(s_stop_timer)) {
        ledc_stop(BUZZER_MODE, BUZZER_CHANNEL, 0);
    }
    xSemaphoreGive(s_lock);
}

void fos_buzzer_init(void)
{
    if (s_lock) return;
    s_lock = xSemaphoreCreateMutex();
    const esp_timer_create_args_t args = {
        .callback = stop_tone,
        .name = "fos_buzzer",
    };
    if (!s_lock || esp_timer_create(&args, &s_stop_timer) != ESP_OK) {
        ESP_LOGW(TAG, "buzzer unavailable: out of memory");
        if (s_lock) vSemaphoreDelete(s_lock);
        s_lock = NULL;
        s_stop_timer = NULL;
    }
}

void fos_buzzer_tone(uint32_t freq_hz, uint32_t duration_ms)
{
    if (!s_lock || freq_hz == 0 || duration_ms == 0) return;
    int pin = fos_config()->buzzer_pin;
    xSemaphoreTake(s_lock, portMAX_DELAY);
    if (attach(pin)) {
        if (freq_hz != s_freq_hz && ledc_set_freq(BUZZER_MODE, BUZZER_TIMER, freq_hz) == ESP_OK) {
            s_freq_hz = freq_hz;
        }
        esp_timer_stop(s_stop_timer); /* a tone already sounding: start over */
        ledc_set_duty(BUZZER_MODE, BUZZER_CHANNEL, BUZZER_HALF_DUTY);
        ledc_update_duty(BUZZER_MODE, BUZZER_CHANNEL);
        esp_timer_start_once(s_stop_timer, (uint64_t)duration_ms * 1000);
    }
    xSemaphoreGive(s_lock);
}

/* The configured pitch, kept inside the contract's bounds whatever NVS held. */
static uint32_t tone_hz(void)
{
    uint32_t hz = fos_config()->buzzer_tone_hz;
    if (hz < FOS_BUZZER_TONE_HZ_MIN || hz > FOS_BUZZER_TONE_HZ_MAX) return TIMER_START_HZ;
    return hz;
}

void fos_buzzer_press_start(void)
{
    fos_buzzer_tone(tone_hz(), FOS_BUZZER_PRESS_MAX_MS);
}

void fos_buzzer_press_end(void)
{
    if (!s_lock) return;
    xSemaphoreTake(s_lock, portMAX_DELAY);
    esp_timer_stop(s_stop_timer);
    if (s_pin >= 0) ledc_stop(BUZZER_MODE, BUZZER_CHANNEL, 0);
    xSemaphoreGive(s_lock);
}

void fos_buzzer_chirp(void)
{
    fos_buzzer_tone(tone_hz(), CHIRP_MS);
}

void fos_buzzer_reject(void)
{
    uint32_t hz = tone_hz() / 4;
    fos_buzzer_tone(hz < REJECT_MIN_HZ ? REJECT_MIN_HZ : hz, REJECT_MS);
}

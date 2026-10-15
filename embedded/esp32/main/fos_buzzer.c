#include "fos_buzzer.h"

#include <stdbool.h>
#include <stdio.h>

#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

#include "driver/gpio.h"
#include "driver/ledc.h"
#include "esp_timer.h"

#include "fos_config.h"

/* Nothing else in the firmware uses LEDC. Take the last timer and channel
 * (the C3 has six channels, the S3 eight) so a future user counting from 0
 * does not land on the buzzer. */
#define BUZZER_MODE LEDC_LOW_SPEED_MODE
#define BUZZER_TIMER ((ledc_timer_t)(LEDC_TIMER_MAX - 1))
#define BUZZER_CHANNEL ((ledc_channel_t)(LEDC_CHANNEL_MAX - 1))
/* 12 bits: on the 80 MHz APB clock the divider (1 … 1023, 8 fractional
 * bits) then reaches 20 Hz … 19.5 kHz, which covers the refused press's
 * 70 Hz up click and the contract's 10 kHz ceiling on one clock. At 10 bits
 * anything under 77 Hz fails ledc_set_freq and the click keeps the previous
 * pitch. */
#define BUZZER_RESOLUTION LEDC_TIMER_12_BIT
#define BUZZER_HALF_DUTY (1u << (BUZZER_RESOLUTION - 1))

/* The LEDC timer's first frequency; every tone sets its own. */
#define TIMER_START_HZ 2000
#define CHIRP_MS 60
/* The press: a click on the way down at the press pitch and one on the way
 * up at 0.7 of it, 14 ms each. Picked by ear against the alternatives
 * (pulses, sweeps, tunes) for being clear at a tap and not a drone at a
 * one-second hold. */
#define CLICK_MS 14
#define CLICK_UP_NUM 7
#define CLICK_UP_DEN 10
/* A refused press: the same pair from a 100 Hz base, so it reads as "no"
 * next to the press's "yes" whatever pitch the frame is set to. */
#define REJECT_DOWN_HZ 100
#define REJECT_UP_HZ (REJECT_DOWN_HZ * CLICK_UP_NUM / CLICK_UP_DEN)

static SemaphoreHandle_t s_lock = NULL;
static esp_timer_handle_t s_stop_timer = NULL;
static bool s_timer_ready = false;
static uint32_t s_freq_hz = 0;
static int s_pin = -1;         /* the pin the channel drives, -1 = none */
static int s_refused_pin = -1; /* said why once; quiet until the pin changes */

/* A pin the chip reserves or the board already uses for something else: a
 * PWM on a button's pull-up or the panel's SPI lines would break the thing it
 * shares with. The setters only check the reserved pads; this catches the
 * rest. */
static bool pin_in_use(const fos_config_t *config, int pin)
{
    if (fos_config_gpio_pin_reserved(pin) != NULL) return true;
    const fos_pins_t *p = &config->pins;
    if (pin == p->rst || pin == p->dc || pin == p->cs || pin == p->cs2 || pin == p->busy ||
        pin == p->sck || pin == p->mosi || pin == p->pwr || pin == config->battery_pin ||
        pin == config->battery_enable_pin) {
        return true;
    }
    for (size_t i = 0; i < config->gpio_button_count; i++) {
        if (config->gpio_buttons[i].pin == pin) return true;
    }
    return config->assets_sd.enabled &&
           (pin == config->assets_sd.cs || pin == config->assets_sd.sck ||
            pin == config->assets_sd.miso || pin == config->assets_sd.mosi);
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

    if (pin_in_use(fos_config(), pin)) {
        if (s_refused_pin != pin) {
            s_refused_pin = pin;
            /* printf: INFO and WARN-only builds alike show it on the console. */
            printf("buzzer: GPIO %d is in use, not driving it\n", pin);
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
        if (ledc_timer_config(&timer) != ESP_OK) return false;
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
    if (ledc_channel_config(&channel) != ESP_OK) return false;
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

void fos_buzzer_click_down(void)
{
    fos_buzzer_tone(tone_hz(), CLICK_MS);
}

void fos_buzzer_click_up(void)
{
    fos_buzzer_tone(tone_hz() * CLICK_UP_NUM / CLICK_UP_DEN, CLICK_MS);
}

void fos_buzzer_chirp(void)
{
    fos_buzzer_tone(tone_hz(), CHIRP_MS);
}

void fos_buzzer_reject_down(void)
{
    fos_buzzer_tone(REJECT_DOWN_HZ, CLICK_MS);
}

void fos_buzzer_reject_up(void)
{
    fos_buzzer_tone(REJECT_UP_HZ, CLICK_MS);
}

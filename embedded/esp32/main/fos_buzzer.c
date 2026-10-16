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
/* The second press of a double press: two short notes climbing above the
 * press pitch with a gap the ear can hear, so it reads as "twice" and not
 * as a longer click. */
#define DOUBLE_NOTE_MS 10
#define DOUBLE_REST_MS 6
/* A long press, at every whole second held: a short note at the press pitch
 * falling to a longer one an octave down, a "dun" that says the hold has
 * turned into something else, once per second it stays that way. */
#define LONG_HEAD_MS 8
#define LONG_TAIL_MS 20

static SemaphoreHandle_t s_lock = NULL;
static esp_timer_handle_t s_stop_timer = NULL;
static bool s_timer_ready = false;
static uint32_t s_freq_hz = 0;
static int s_pin = -1;         /* the pin the channel drives, -1 = none */
static int s_refused_pin = -1; /* said why once; quiet until the pin changes */
/* The sequence sounding now: the stop timer steps through it. */
static fos_buzzer_note_t s_notes[FOS_BUZZER_NOTES_MAX];
static size_t s_note_count = 0;
static size_t s_note_next = 0;

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

/* Sound one note (a rest stops the output) and arm the timer for its end.
 * Caller holds s_lock and has attached the pin. */
static void start_note_locked(const fos_buzzer_note_t *note)
{
    if (note->freq_hz == 0) {
        ledc_stop(BUZZER_MODE, BUZZER_CHANNEL, 0);
    } else {
        if (note->freq_hz != s_freq_hz && ledc_set_freq(BUZZER_MODE, BUZZER_TIMER, note->freq_hz) == ESP_OK) {
            s_freq_hz = note->freq_hz;
        }
        ledc_set_duty(BUZZER_MODE, BUZZER_CHANNEL, BUZZER_HALF_DUTY);
        ledc_update_duty(BUZZER_MODE, BUZZER_CHANNEL);
    }
    esp_timer_start_once(s_stop_timer, (uint64_t)note->duration_ms * 1000);
}

static void stop_tone(void *arg)
{
    (void)arg;
    xSemaphoreTake(s_lock, portMAX_DELAY);
    /* Active again: a new sound restarted the timer while this callback
     * waited for the lock, and it is not over yet. */
    if (s_pin >= 0 && !esp_timer_is_active(s_stop_timer)) {
        if (s_note_next < s_note_count) {
            start_note_locked(&s_notes[s_note_next++]);
        } else {
            ledc_stop(BUZZER_MODE, BUZZER_CHANNEL, 0);
            s_note_count = s_note_next = 0;
        }
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

void fos_buzzer_play(const fos_buzzer_note_t *notes, size_t count)
{
    if (!s_lock || !notes || count == 0) return;
    if (count > FOS_BUZZER_NOTES_MAX) count = FOS_BUZZER_NOTES_MAX;
    int pin = fos_config()->buzzer_pin;
    xSemaphoreTake(s_lock, portMAX_DELAY);
    if (attach(pin)) {
        esp_timer_stop(s_stop_timer); /* a sound already playing: start over */
        s_note_count = 0;
        for (size_t i = 0; i < count; i++) {
            if (notes[i].duration_ms == 0) continue;
            s_notes[s_note_count++] = notes[i];
        }
        s_note_next = 0;
        if (s_note_count > 0) start_note_locked(&s_notes[s_note_next++]);
    }
    xSemaphoreGive(s_lock);
}

void fos_buzzer_tone(uint32_t freq_hz, uint32_t duration_ms)
{
    if (freq_hz == 0 || duration_ms == 0) return;
    const fos_buzzer_note_t note = {freq_hz, duration_ms};
    fos_buzzer_play(&note, 1);
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

/* A multiple of the press pitch, inside what the LEDC timer and the contract
 * allow. */
static uint32_t scaled_hz(uint32_t num, uint32_t den)
{
    uint32_t hz = tone_hz() * num / den;
    if (hz < FOS_BUZZER_TONE_HZ_MIN) return FOS_BUZZER_TONE_HZ_MIN;
    if (hz > FOS_BUZZER_TONE_HZ_MAX) return FOS_BUZZER_TONE_HZ_MAX;
    return hz;
}

void fos_buzzer_double_down(void)
{
    const fos_buzzer_note_t notes[] = {
        {scaled_hz(3, 2), DOUBLE_NOTE_MS},
        {0, DOUBLE_REST_MS},
        {scaled_hz(2, 1), DOUBLE_NOTE_MS},
    };
    fos_buzzer_play(notes, sizeof(notes) / sizeof(notes[0]));
}

void fos_buzzer_long_press(void)
{
    const fos_buzzer_note_t notes[] = {
        {tone_hz(), LONG_HEAD_MS},
        {scaled_hz(1, 2), LONG_TAIL_MS},
    };
    fos_buzzer_play(notes, sizeof(notes) / sizeof(notes[0]));
}


void fos_buzzer_reject_down(void)
{
    fos_buzzer_tone(REJECT_DOWN_HZ, CLICK_MS);
}

void fos_buzzer_reject_up(void)
{
    fos_buzzer_tone(REJECT_UP_HZ, CLICK_MS);
}

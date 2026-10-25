#include "fos_led.h"

#include <stdio.h>

#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

#include "driver/gpio.h"
#include "esp_cpu.h"
#include "esp_rom_sys.h"
#include "hal/gpio_ll.h"
#include "soc/gpio_struct.h"

#include "fos_config.h"

/* What a lit WS2812 pixel shows: a soft white, well under full drive so a
 * desk frame's LED is a cue and not a lamp. GRB on the wire. */
#define WS2812_LIT_G 0x28
#define WS2812_LIT_R 0x28
#define WS2812_LIT_B 0x28
/* WS2812 timing: a 0 is ~0.35 µs high / ~0.9 µs low, a 1 ~0.9 µs high /
 * ~0.35 µs low (±150 ns), then ≥50 µs low to latch (300 µs for the newer
 * parts). One pixel is 24 bits = 30 µs, bit-banged with interrupts off and
 * the CPU cycle counter as the clock: a few hundred bytes, where the RMT
 * driver this used first cost ~4.6 KB of flash and 2.2 KB of IRAM. */
#define WS2812_T0H_NS 350
#define WS2812_T1H_NS 900
#define WS2812_BIT_NS 1250
#define WS2812_RESET_US 300

static SemaphoreHandle_t s_lock = NULL;
static int s_pin = -1;         /* the pin set up, -1 = none */
static uint8_t s_type = FOS_LED_GPIO;
static int s_refused_pin = -1; /* said why once; quiet until the pin changes */
static bool s_on = false;       /* what the pin shows */
static bool s_note_on = false;  /* what the notes ask for */
static bool s_hold = false;     /* a recording: lit whatever the notes say */

/* The pins the rest of the board owns: the panel, the battery sense, the
 * buttons, the card, the buzzer, the microphone, the I2C buses. An LED on one
 * of them would break what it shares with. */
static const char *pin_in_use(const fos_config_t *config, int pin)
{
    const char *why = fos_config_gpio_pin_reserved(pin);
    if (why) return why;
    const fos_pins_t *p = &config->pins;
    if (pin == p->rst || pin == p->dc || pin == p->cs || pin == p->cs2 || pin == p->busy ||
        pin == p->sck || pin == p->mosi || pin == p->pwr) {
        return "a panel pin";
    }
    if (pin == config->battery_pin || pin == config->battery_enable_pin) return "the battery sense";
    for (size_t i = 0; i < config->gpio_button_count; i++) {
        if (config->gpio_buttons[i].pin == pin) return "a button";
    }
    if (config->assets_sd.enabled &&
        (pin == config->assets_sd.cs || pin == config->assets_sd.sck || pin == config->assets_sd.miso ||
         pin == config->assets_sd.mosi || pin == config->assets_sd.pwr || pin == config->assets_sd.det)) {
        return "the SD card";
    }
    if (pin == config->buzzer_pin) return "the buzzer";
    if (pin == config->mic_pins.clk || pin == config->mic_pins.data || pin == config->mic_pins.pwr) {
        return "the microphone";
    }
    for (size_t i = 0; i < config->i2c_bus_count; i++) {
        if (pin == config->i2c_buses[i].sda || pin == config->i2c_buses[i].scl) return "an I2C bus";
    }
    return NULL;
}

static void release_locked(void)
{
    if (s_pin < 0) return;
    gpio_reset_pin((gpio_num_t)s_pin);
    s_pin = -1;
    s_on = false;
}

/* Clock out one GRB pixel. Interrupts off for the 30 µs so a tick cannot
 * stretch a bit; the pin is set through the GPIO registers directly (a
 * function call per edge would eat most of a 350 ns high). */
static void IRAM_ATTR ws2812_write(int pin, const uint8_t grb[3])
{
    uint32_t per_us = esp_rom_get_cpu_ticks_per_us();
    uint32_t t0h = per_us * WS2812_T0H_NS / 1000;
    uint32_t t1h = per_us * WS2812_T1H_NS / 1000;
    uint32_t bit = per_us * WS2812_BIT_NS / 1000;
    portDISABLE_INTERRUPTS();
    for (int i = 0; i < 3; i++) {
        for (int b = 7; b >= 0; b--) {
            uint32_t high = (grb[i] >> b) & 1 ? t1h : t0h;
            uint32_t start = esp_cpu_get_cycle_count();
            gpio_ll_set_level(&GPIO, (gpio_num_t)pin, 1);
            while (esp_cpu_get_cycle_count() - start < high) {}
            gpio_ll_set_level(&GPIO, (gpio_num_t)pin, 0);
            while (esp_cpu_get_cycle_count() - start < bit) {}
        }
    }
    portENABLE_INTERRUPTS();
    /* The reset gap: the pixel latches once the line is quiet. */
    esp_rom_delay_us(WS2812_RESET_US);
}

/* Point at the live config's LED, letting go of the previous one. Under
 * s_lock. True when there is an LED to drive. */
static bool attach_locked(void)
{
    const fos_config_t *config = fos_config();
    int pin = config->led_pin;
    uint8_t type = config->led_type;
    if (pin == s_pin && type == s_type) return s_pin >= 0;
    release_locked();
    s_type = type;
    if (pin < 0) {
        s_refused_pin = -1;
        return false;
    }
    const char *why = pin_in_use(config, pin);
    if (why) {
        if (s_refused_pin != pin) {
            s_refused_pin = pin;
            /* printf: INFO and WARN-only builds alike show it on the console. */
            printf("led: GPIO %d is %s, not driving it\n", pin, why);
        }
        return false;
    }
    gpio_reset_pin((gpio_num_t)pin);
    gpio_set_direction((gpio_num_t)pin, GPIO_MODE_OUTPUT);
    gpio_set_level((gpio_num_t)pin, type == FOS_LED_GPIO_INVERTED ? 1 : 0);
    s_pin = pin;
    s_refused_pin = -1;
    return true;
}

static void show_locked(bool on)
{
    if (s_type == FOS_LED_WS2812) {
        const uint8_t lit[3] = {WS2812_LIT_G, WS2812_LIT_R, WS2812_LIT_B};
        const uint8_t dark[3] = {0, 0, 0};
        ws2812_write(s_pin, on ? lit : dark);
    } else {
        bool high = on != (s_type == FOS_LED_GPIO_INVERTED);
        gpio_set_level((gpio_num_t)s_pin, high ? 1 : 0);
    }
    s_on = on;
}

void fos_led_init(void)
{
    if (s_lock) return;
    s_lock = xSemaphoreCreateMutex();
    /* Claim the pin now and drive it dark: left floating until the first
     * note, the E1004's LED glowed green from reset until something pressed
     * a key (its transistor's base floats high), and an inverted LED can sit
     * half-lit the same way. */
    fos_led_set(false);
}

/* Show the notes' state or the hold, whichever is lit. Under s_lock. */
static void refresh_locked(void)
{
    bool want = s_note_on || s_hold;
    if (attach_locked() && (s_on != want || want)) show_locked(want);
}

void fos_led_set(bool on)
{
    if (!s_lock) return;
    xSemaphoreTake(s_lock, portMAX_DELAY);
    s_note_on = on;
    refresh_locked();
    xSemaphoreGive(s_lock);
}

void fos_led_hold(bool held)
{
    if (!s_lock) return;
    xSemaphoreTake(s_lock, portMAX_DELAY);
    s_hold = held;
    refresh_locked();
    xSemaphoreGive(s_lock);
}

bool fos_led_present(void)
{
    if (!s_lock) return false;
    xSemaphoreTake(s_lock, portMAX_DELAY);
    bool present = attach_locked();
    xSemaphoreGive(s_lock);
    return present;
}

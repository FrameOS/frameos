#include "fos_led.h"

#include <stdio.h>

#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

#include "driver/gpio.h"
#include "driver/rmt_encoder.h"
#include "driver/rmt_tx.h"
#include "esp_log.h"
#include "esp_rom_sys.h"

#include "fos_config.h"

static const char *TAG = "fos_led";

/* What a lit WS2812 pixel shows: a soft white, well under full drive so a
 * desk frame's LED is a cue and not a lamp. GRB on the wire. */
#define WS2812_LIT_G 0x28
#define WS2812_LIT_R 0x28
#define WS2812_LIT_B 0x28
/* WS2812 timing at a 10 MHz RMT tick (100 ns): 0 = 0.3 µs high / 0.9 µs low,
 * 1 = 0.9 µs high / 0.3 µs low, inside the datasheet's ±150 ns. */
#define WS2812_RESOLUTION_HZ 10000000
#define WS2812_T0H 3
#define WS2812_T0L 9
#define WS2812_T1H 9
#define WS2812_T1L 3
/* The reset gap after a frame: the datasheet asks for 50 µs, newer parts
 * for 280 µs; 300 µs covers both. */
#define WS2812_RESET_US 300

static SemaphoreHandle_t s_lock = NULL;
static int s_pin = -1;         /* the pin set up, -1 = none */
static uint8_t s_type = FOS_LED_GPIO;
static int s_refused_pin = -1; /* said why once; quiet until the pin changes */
static bool s_on = false;
static rmt_channel_handle_t s_rmt = NULL;
static rmt_encoder_handle_t s_rmt_bytes = NULL;

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
    if (s_rmt) {
        rmt_disable(s_rmt);
        rmt_del_channel(s_rmt);
        s_rmt = NULL;
    }
    if (s_rmt_bytes) {
        rmt_del_encoder(s_rmt_bytes);
        s_rmt_bytes = NULL;
    }
    gpio_reset_pin((gpio_num_t)s_pin);
    s_pin = -1;
    s_on = false;
}

static bool setup_ws2812_locked(int pin)
{
    rmt_tx_channel_config_t channel = {
        .gpio_num = (gpio_num_t)pin,
        .clk_src = RMT_CLK_SRC_DEFAULT,
        .resolution_hz = WS2812_RESOLUTION_HZ,
        .mem_block_symbols = 64,
        .trans_queue_depth = 2,
    };
    if (rmt_new_tx_channel(&channel, &s_rmt) != ESP_OK) return false;
    rmt_bytes_encoder_config_t bytes = {
        .bit0 = {.level0 = 1, .duration0 = WS2812_T0H, .level1 = 0, .duration1 = WS2812_T0L},
        .bit1 = {.level0 = 1, .duration0 = WS2812_T1H, .level1 = 0, .duration1 = WS2812_T1L},
        .flags.msb_first = 1,
    };
    if (rmt_new_bytes_encoder(&bytes, &s_rmt_bytes) != ESP_OK ||
        rmt_enable(s_rmt) != ESP_OK) {
        if (s_rmt_bytes) rmt_del_encoder(s_rmt_bytes);
        rmt_del_channel(s_rmt);
        s_rmt_bytes = NULL;
        s_rmt = NULL;
        return false;
    }
    return true;
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
    if (type == FOS_LED_WS2812) {
        if (!setup_ws2812_locked(pin)) {
            ESP_LOGW(TAG, "WS2812 on GPIO %d: RMT channel unavailable", pin);
            return false;
        }
    } else {
        gpio_reset_pin((gpio_num_t)pin);
        gpio_set_direction((gpio_num_t)pin, GPIO_MODE_OUTPUT);
        gpio_set_level((gpio_num_t)pin, type == FOS_LED_GPIO_INVERTED ? 1 : 0);
    }
    s_pin = pin;
    s_refused_pin = -1;
    return true;
}

static void show_locked(bool on)
{
    if (s_type == FOS_LED_WS2812) {
        const uint8_t lit[3] = {WS2812_LIT_G, WS2812_LIT_R, WS2812_LIT_B};
        const uint8_t dark[3] = {0, 0, 0};
        rmt_transmit_config_t tx = {.loop_count = 0};
        if (rmt_transmit(s_rmt, s_rmt_bytes, on ? lit : dark, 3, &tx) == ESP_OK) {
            rmt_tx_wait_all_done(s_rmt, 20);
            /* The reset gap: the pixel latches once the line is quiet. */
            esp_rom_delay_us(WS2812_RESET_US);
        }
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
}

void fos_led_set(bool on)
{
    if (!s_lock) return;
    xSemaphoreTake(s_lock, portMAX_DELAY);
    if (attach_locked() && (s_on != on || on)) show_locked(on);
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

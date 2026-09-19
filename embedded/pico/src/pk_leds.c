#include "pk_leds.h"

#include <string.h>

#include "hardware/gpio.h"
#include "pico/stdlib.h"

#include "pk_config.h"

#define LED_ACTIVITY 6
#define LED_CONNECTION 7
#define LED_BUTTON_FIRST 11
#define LED_BUTTON_COUNT 5
#define BLINK_HALF_PERIOD_MS 400
#define BUTTON_FLASH_MS 600

static bool s_enabled = false;
static pk_led_mode_t s_activity = PK_LED_OFF;
static pk_led_mode_t s_connection = PK_LED_OFF;
static absolute_time_t s_button_off_at[LED_BUTTON_COUNT];
static bool s_button_lit[LED_BUTTON_COUNT];

static void led_init(uint gpio)
{
    gpio_init(gpio);
    gpio_set_dir(gpio, GPIO_OUT);
    gpio_put(gpio, 0);
}

void pk_leds_init(void)
{
    s_enabled = strncmp(pk_config()->hardware_preset, "pimoroni_inky_frame", 19) == 0;
    if (!s_enabled) return;
    led_init(LED_ACTIVITY);
    led_init(LED_CONNECTION);
    for (int i = 0; i < LED_BUTTON_COUNT; i++) led_init((uint)(LED_BUTTON_FIRST + i));
}

void pk_leds_activity(pk_led_mode_t mode)
{
    s_activity = mode;
    pk_leds_tick();
}

void pk_leds_connection(pk_led_mode_t mode)
{
    s_connection = mode;
    pk_leds_tick();
}

void pk_leds_button(int index)
{
    if (!s_enabled || index < 0 || index >= LED_BUTTON_COUNT) return;
    s_button_lit[index] = true;
    s_button_off_at[index] = make_timeout_time_ms(BUTTON_FLASH_MS);
    gpio_put((uint)(LED_BUTTON_FIRST + index), 1);
}

void pk_leds_all_off(void)
{
    s_activity = PK_LED_OFF;
    s_connection = PK_LED_OFF;
    if (!s_enabled) return;
    for (int i = 0; i < LED_BUTTON_COUNT; i++) {
        s_button_lit[i] = false;
        gpio_put((uint)(LED_BUTTON_FIRST + i), 0);
    }
    pk_leds_tick();
}

static bool level_for(pk_led_mode_t mode, bool blink_phase)
{
    return mode == PK_LED_ON || (mode == PK_LED_BLINK && blink_phase);
}

void pk_leds_tick(void)
{
    if (!s_enabled) return;
    bool phase = (to_ms_since_boot(get_absolute_time()) / BLINK_HALF_PERIOD_MS) % 2 == 0;
    gpio_put(LED_ACTIVITY, level_for(s_activity, phase));
    gpio_put(LED_CONNECTION, level_for(s_connection, phase));
    for (int i = 0; i < LED_BUTTON_COUNT; i++) {
        if (s_button_lit[i] && absolute_time_diff_us(get_absolute_time(), s_button_off_at[i]) < 0) {
            s_button_lit[i] = false;
            gpio_put((uint)(LED_BUTTON_FIRST + i), 0);
        }
    }
}

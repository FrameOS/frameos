#include "pk_shiftreg.h"

#include "hardware/gpio.h"
#include "pico/stdlib.h"

static void ensure_inputs(const pk_pins_t *pins)
{
    static bool initialized = false;
    if (initialized) return;
    gpio_init(pins->sr_clock);
    gpio_set_dir(pins->sr_clock, GPIO_OUT);
    gpio_put(pins->sr_clock, 0);
    gpio_init(pins->sr_latch);
    gpio_set_dir(pins->sr_latch, GPIO_OUT);
    gpio_put(pins->sr_latch, 1);
    gpio_init(pins->sr_data);
    gpio_set_dir(pins->sr_data, GPIO_IN);
    initialized = true;
}

uint8_t pk_shiftreg_read(const pk_pins_t *pins)
{
    if (pins->sr_clock < 0 || pins->sr_latch < 0 || pins->sr_data < 0) {
        return 0xFF;
    }
    ensure_inputs(pins);
    // Latch the parallel inputs, then clock the 8 bits out MSB-first.
    gpio_put(pins->sr_latch, 0);
    busy_wait_us(1);
    gpio_put(pins->sr_latch, 1);
    busy_wait_us(1);
    uint8_t value = 0;
    for (int bit = 7; bit >= 0; bit--) {
        if (gpio_get(pins->sr_data)) {
            value |= (uint8_t)(1u << bit);
        }
        gpio_put(pins->sr_clock, 1);
        busy_wait_us(1);
        gpio_put(pins->sr_clock, 0);
        busy_wait_us(1);
    }
    return value;
}

bool pk_display_busy(const pk_pins_t *pins)
{
    if (pins->busy >= 0) {
        static bool busy_init = false;
        if (!busy_init) {
            gpio_init(pins->busy);
            gpio_set_dir(pins->busy, GPIO_IN);
            gpio_pull_up(pins->busy);
            busy_init = true;
        }
        // Panel families used here signal LOW while busy.
        return gpio_get(pins->busy) == 0;
    }
    if (pins->sr_clock >= 0 && pins->busy_bit >= 0) {
        return (pk_shiftreg_read(pins) & (1u << pins->busy_bit)) == 0;
    }
    return false;
}

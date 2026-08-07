#include "pk_rtc.h"

#include <stdio.h>

#include "hardware/gpio.h"
#include "hardware/i2c.h"
#include "pico/stdlib.h"

#include "pk_config.h"

// Inky Frame wiring (all variants): PCF85063A on i2c0 GP4/GP5.
#define PK_RTC_I2C i2c0
#define PK_RTC_SDA 4
#define PK_RTC_SCL 5
#define PK_RTC_ADDR 0x51

#define REG_CONTROL_1 0x00
#define REG_CONTROL_2 0x01
#define REG_TIMER_VALUE 0x10
#define REG_TIMER_MODE 0x11

// TIMER_MODE bits: [4:3] clock 00=4096Hz 01=64Hz 10=1Hz 11=1/60Hz,
// [2] timer enable, [1] interrupt enable, [0] interrupt is pulse
#define TIMER_1_OVER_60HZ 0x18
#define TIMER_1HZ 0x10
#define TIMER_ENABLE 0x04
#define TIMER_INT_ENABLE 0x02

static bool s_initialized = false;
static bool s_present = false;

static bool reg_write(uint8_t reg, uint8_t value)
{
    uint8_t buffer[2] = {reg, value};
    return i2c_write_blocking(PK_RTC_I2C, PK_RTC_ADDR, buffer, 2, false) == 2;
}

void pk_rtc_init(void)
{
    if (s_initialized) return;
    s_initialized = true;
    i2c_init(PK_RTC_I2C, 100 * 1000);
    gpio_set_function(PK_RTC_SDA, GPIO_FUNC_I2C);
    gpio_set_function(PK_RTC_SCL, GPIO_FUNC_I2C);
    gpio_pull_up(PK_RTC_SDA);
    gpio_pull_up(PK_RTC_SCL);
    // Disable CLOCK_OUT and clear pending timer/alarm flags; also proves the
    // chip is there. (Same first-touch the Pimoroni wakeup module does.)
    s_present = reg_write(REG_CONTROL_2, 0x07);
}

bool pk_rtc_present(void)
{
    pk_rtc_init();
    return s_present;
}

void pk_rtc_sleep_minutes(uint32_t minutes)
{
    pk_config_t *config = pk_config();
    if (minutes == 0) minutes = 1;
    if (!pk_rtc_present() || config->pins.hold_vsys < 0) {
        printf("sleep: no RTC/power latch, staying awake\n");
        return;
    }
    // Countdown timer: 1/60Hz ticks = whole minutes, max 255.
    if (minutes > 255) minutes = 255;
    reg_write(REG_CONTROL_2, 0x07);                 // clear flags
    reg_write(REG_TIMER_VALUE, (uint8_t)minutes);
    reg_write(REG_TIMER_MODE, TIMER_1_OVER_60HZ | TIMER_ENABLE | TIMER_INT_ENABLE);

    printf("sleep: powering off for %lu min (RTC wake)\n", (unsigned long)minutes);
    stdio_flush();
    sleep_ms(50);
    // Release the power latch. On battery the 3V3 rail drops here and the
    // RTC interrupt (or a button) re-enables the regulator later.
    gpio_put(config->pins.hold_vsys, 0);
    sleep_ms(2000);
    // Still running: VSYS is fed by USB. Re-assert the latch and simulate
    // the sleep so behaviour matches battery operation.
    gpio_put(config->pins.hold_vsys, 1);
    printf("sleep: USB powered, sleeping in place\n");
    for (uint32_t elapsed = 0; elapsed < minutes * 60u; elapsed += 5) {
        sleep_ms(5000);
    }
}

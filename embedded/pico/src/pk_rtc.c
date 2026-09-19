#include "pk_rtc.h"

#include <stdio.h>

#include "hardware/gpio.h"
#include "hardware/i2c.h"
#include "pico/stdlib.h"

#include "pk_config.h"
#include "pk_datetime.h"
#include "pk_leds.h"
#include "pk_log.h"
#include "pk_platform.h"

// Inky Frame wiring (all variants): PCF85063A on i2c0 GP4/GP5.
#define PK_RTC_I2C i2c0
#define PK_RTC_SDA 4
#define PK_RTC_SCL 5
#define PK_RTC_ADDR 0x51

#define REG_CONTROL_1 0x00
#define REG_CONTROL_2 0x01
#define REG_SECONDS 0x04 // … minutes, hours, days, weekdays, months, years
#define REG_TIMER_VALUE 0x10
#define REG_TIMER_MODE 0x11

// TIMER_MODE bits: [4:3] clock 00=4096Hz 01=64Hz 10=1Hz 11=1/60Hz,
// [2] timer enable, [1] interrupt enable, [0] interrupt is pulse
#define TIMER_1_OVER_60HZ 0x18
#define TIMER_1HZ 0x10
#define TIMER_ENABLE 0x04
#define TIMER_INT_ENABLE 0x02

#define SECONDS_OSCILLATOR_STOPPED 0x80

static bool s_initialized = false;
static bool s_present = false;

static bool reg_write(uint8_t reg, uint8_t value)
{
    uint8_t buffer[2] = {reg, value};
    return i2c_write_timeout_us(PK_RTC_I2C, PK_RTC_ADDR, buffer, 2, false, 20000) == 2;
}

static bool reg_read(uint8_t reg, uint8_t *dst, size_t len)
{
    if (i2c_write_timeout_us(PK_RTC_I2C, PK_RTC_ADDR, &reg, 1, true, 20000) != 1) return false;
    return i2c_read_timeout_us(PK_RTC_I2C, PK_RTC_ADDR, dst, len, false, 20000) == (int)len;
}

void pk_rtc_init(void)
{
    if (s_initialized) return;
    s_initialized = true;
    // Only the Inky Frame has this chip on these pins; on a bare Pico GP4/5
    // are the user's.
    if (pk_config()->pins.hold_vsys < 0) return;
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

uint32_t pk_rtc_read_epoch(void)
{
    if (!pk_rtc_present()) return 0;
    uint8_t raw[7];
    if (!reg_read(REG_SECONDS, raw, sizeof(raw))) return 0;
    if (raw[0] & SECONDS_OSCILLATOR_STOPPED) return 0; // lost power: the time is garbage
    pk_datetime_t dt = {
        .second = pk_bcd_decode(raw[0] & 0x7F),
        .minute = pk_bcd_decode(raw[1] & 0x7F),
        .hour = pk_bcd_decode(raw[2] & 0x3F),
        .day = pk_bcd_decode(raw[3] & 0x3F),
        .month = pk_bcd_decode(raw[5] & 0x1F),
        .year = 2000 + pk_bcd_decode(raw[6]),
    };
    // 2026 or later, or it was never set by this firmware.
    if (!pk_datetime_valid(&dt) || dt.year < 2026) return 0;
    return (uint32_t)pk_datetime_to_epoch(&dt);
}

void pk_rtc_write_epoch(uint32_t epoch)
{
    if (!pk_rtc_present()) return;
    pk_datetime_t dt;
    pk_datetime_from_epoch((int64_t)epoch, &dt);
    if (!pk_datetime_valid(&dt)) return;
    int64_t days = pk_days_from_civil(dt.year, dt.month, dt.day);
    uint8_t buffer[8] = {
        REG_SECONDS,
        pk_bcd_encode(dt.second), // also clears the oscillator-stopped flag
        pk_bcd_encode(dt.minute),
        pk_bcd_encode(dt.hour),
        pk_bcd_encode(dt.day),
        (uint8_t)((days + 4) % 7), // 1970-01-01 was a Thursday
        pk_bcd_encode(dt.month),
        pk_bcd_encode(dt.year - 2000),
    };
    i2c_write_timeout_us(PK_RTC_I2C, PK_RTC_ADDR, buffer, sizeof(buffer), false, 20000);
}

bool pk_rtc_arm_wake(uint32_t seconds)
{
    if (!pk_rtc_present()) return false;
    if (seconds == 0) seconds = 1;
    if (seconds > PK_RTC_MAX_SLEEP_SECONDS) seconds = PK_RTC_MAX_SLEEP_SECONDS;
    // Countdown timer: 1 Hz ticks up to 255 s, else 1/60 Hz ticks (rounded
    // up, so a frame never wakes before its interval).
    uint8_t mode = TIMER_1HZ;
    uint32_t ticks = seconds;
    if (seconds > 255) {
        mode = TIMER_1_OVER_60HZ;
        ticks = (seconds + 59) / 60;
        if (ticks > 255) ticks = 255;
    }
    uint8_t armed = 0;
    bool ok = reg_write(REG_TIMER_MODE, 0) &&        // stop a running countdown first
              reg_write(REG_CONTROL_2, 0x07) &&      // clear flags
              reg_write(REG_TIMER_VALUE, (uint8_t)ticks) &&
              reg_write(REG_TIMER_MODE, (uint8_t)(mode | TIMER_ENABLE | TIMER_INT_ENABLE)) &&
              reg_read(REG_TIMER_MODE, &armed, 1);
    return ok && (armed & TIMER_ENABLE) != 0;
}

void pk_rtc_sleep(uint32_t seconds, bool (*abort)(void))
{
    pk_config_t *config = pk_config();
    if (seconds == 0) seconds = 1;
    if (seconds > PK_RTC_MAX_SLEEP_SECONDS) seconds = PK_RTC_MAX_SLEEP_SECONDS;
    if (!pk_rtc_present() || config->pins.hold_vsys < 0) {
        pk_logf("sleep: no RTC/power latch on this board, staying awake");
        return;
    }
    if (!pk_rtc_arm_wake(seconds)) {
        // Cutting the power now would be for good.
        pk_logf("sleep: the RTC did not take the wake timer, staying awake");
        return;
    }

    printf("sleep: powering off for %lus (RTC wake)\n", (unsigned long)seconds);
    pk_leds_all_off();
    stdio_flush();
    sleep_ms(50);
    // Release the power latch. On battery the 3V3 rail drops here and the
    // RTC interrupt (or a button) re-enables the regulator later.
    gpio_put(config->pins.hold_vsys, 0);
    sleep_ms(2000);
    // Still running: VSYS is fed by USB. Re-assert the latch and wait the
    // interval out in place, so behaviour matches battery operation.
    gpio_put(config->pins.hold_vsys, 1);
    reg_write(REG_TIMER_MODE, 0); // no stray wake interrupt later
    printf("sleep: USB powered, waiting in place\n");
    absolute_time_t deadline = make_timeout_time_ms(seconds * 1000u);
    while (absolute_time_diff_us(get_absolute_time(), deadline) > 0) {
        if (abort != NULL && abort()) break;
        pk_wait_ms(50);
    }
}

/*
 * Host tests for the pure halves of the I2C chip drivers: the charger's
 * register decode (fos_charger.c), the clock's BCD conversions (fos_rtc.c)
 * and the fuel gauge's word decode (fos_gauge.c). No IDF: the files keep
 * their arithmetic above the ESP_PLATFORM guard.
 *
 * Build and run (from embedded/esp32/):
 *
 *   cc -std=c11 -Wall -Wextra -Werror -O2 -Imain \
 *      main/fos_charger.c main/fos_rtc.c main/fos_gauge.c main/tests/test_fos_i2c_devices.c \
 *      -o /tmp/test_fos_i2c_devices && /tmp/test_fos_i2c_devices
 *
 * (backend/app/tasks/tests/test_esp32_i2c_devices.py does exactly that in CI.)
 */
#include <stdio.h>
#include <string.h>

#include "fos_charger.h"
#include "fos_gauge.h"
#include "fos_rtc.h"

static int g_failures = 0;
static int g_checks = 0;

#define CHECK(cond, ...)                                                       \
    do {                                                                       \
        g_checks++;                                                            \
        if (!(cond)) {                                                         \
            g_failures++;                                                      \
            printf("FAIL %s:%d: ", __func__, __LINE__);                        \
            printf(__VA_ARGS__);                                               \
            printf("\n");                                                      \
        }                                                                      \
    } while (0)

static void test_charger_decode(void)
{
    fos_charger_status_t s;
    /* On USB, fast charging: VBUS_STAT 001, CHRG_STAT 10, PG, VSYS; VBUS_GD. */
    fos_charger_decode(0x20 | 0x10 | 0x04 | 0x01, 0x80, &s);
    CHECK(s.usb_power && s.charging && !s.charge_done, "USB + fast charge");
    CHECK(s.vbus_stat == 1 && s.chrg_stat == 2, "raw fields %u/%u", s.vbus_stat, s.chrg_stat);
    /* Adapter, charge done. */
    fos_charger_decode(0x40 | 0x18 | 0x04, 0x80, &s);
    CHECK(s.usb_power && !s.charging && s.charge_done, "adapter + done");
    /* Unplugged: nothing on the input, idle. */
    fos_charger_decode(0x00, 0x00, &s);
    CHECK(!s.usb_power && !s.charging && !s.charge_done, "unplugged");
    /* A cell on its own while the chip still reports pre-charge bits (it does
     * not, but the decode must not call that charging without an input). */
    fos_charger_decode(0x08, 0x00, &s);
    CHECK(!s.usb_power && !s.charging, "no input: never charging");
    /* VBUS good alone (PG not yet) counts as input power. */
    fos_charger_decode(0x20, 0x80, &s);
    CHECK(s.usb_power, "VBUS_GD alone is input power");
    /* An input being qualified (VBUS_STAT set, neither PG nor VBUS_GD): not
     * yet. */
    fos_charger_decode(0x20, 0x00, &s);
    CHECK(!s.usb_power, "VBUS_STAT without PG / VBUS_GD is not power yet");
    /* OTG: the board drives VBUS; that is not being powered. */
    fos_charger_decode(0xE0 | 0x04, 0x80, &s);
    CHECK(!s.usb_power && s.vbus_stat == 7, "OTG is not input power");
}

static void test_rtc_decode_and_encode(void)
{
    /* 2026-10-25 14:03:09 UTC, a Sunday, as the PCF8563 holds it. */
    uint8_t regs[FOS_RTC_TIME_LEN] = {0x09, 0x03, 0x14, 0x25, 0x00, 0x10, 0x26};
    time_t t = 0;
    CHECK(fos_rtc_decode(regs, &t), "decoded");
    CHECK(t == 1792936989, "epoch %lld", (long long)t);
    uint8_t back[FOS_RTC_TIME_LEN];
    fos_rtc_encode(t, back);
    CHECK(memcmp(back, regs, 4) == 0, "seconds..days round trip");
    CHECK(back[4] == 0, "weekday Sunday = 0, got %u", back[4]);
    CHECK(back[5] == 0x10 && back[6] == 0x26, "month/year round trip %02x/%02x", back[5], back[6]);
    /* The VL bit: the chip lost power (first boot, backup cell flat). */
    uint8_t unset[FOS_RTC_TIME_LEN] = {0x80 | 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00};
    CHECK(!fos_rtc_decode(unset, &t), "VL set is not a time");
    /* Garbage BCD. */
    uint8_t bad[FOS_RTC_TIME_LEN] = {0x7A, 0x00, 0x00, 0x01, 0x00, 0x01, 0x26};
    CHECK(!fos_rtc_decode(bad, &t), "seconds 7A refused");
    uint8_t month13[FOS_RTC_TIME_LEN] = {0x00, 0x00, 0x00, 0x01, 0x00, 0x13, 0x26};
    CHECK(!fos_rtc_decode(month13, &t), "month 13 refused");
    /* The epoch itself, and a leap day. */
    fos_rtc_encode(946684800, back); /* 2000-01-01 00:00:00, a Saturday */
    CHECK(back[0] == 0 && back[1] == 0 && back[2] == 0 && back[3] == 0x01 && back[5] == 0x01 && back[6] == 0x00,
          "2000-01-01 encodes");
    CHECK(back[4] == 6, "2000-01-01 was a Saturday (6), got %u", back[4]);
    CHECK(fos_rtc_decode(back, &t) && t == 946684800, "and decodes back");
    uint8_t leap[FOS_RTC_TIME_LEN] = {0x00, 0x00, 0x12, 0x29, 0x00, 0x02, 0x28}; /* 2028-02-29 12:00 */
    CHECK(fos_rtc_decode(leap, &t), "leap day decodes");
    fos_rtc_encode(t, back);
    CHECK(back[3] == 0x29 && back[5] == 0x02 && back[6] == 0x28, "leap day round trip");
    /* The century bit on the month register is ignored on the way in and
     * clear on the way out: FrameOS lives in 20xx. */
    uint8_t century[FOS_RTC_TIME_LEN] = {0x00, 0x00, 0x00, 0x01, 0x00, 0x81, 0x26};
    CHECK(fos_rtc_decode(century, &t), "century bit ignored");
    fos_rtc_encode(t, back);
    CHECK((back[5] & 0x80) == 0, "century bit clear on write");
}

static void test_gauge_decode(void)
{
    fos_gauge_status_t g;
    /* On the desk, USB in, the cell taking 180 mA: not discharging. */
    fos_gauge_decode(4050, 82, 180, FOS_GAUGE_STATUS_BATTPRES, &g);
    CHECK(g.present && g.mv == 4050 && g.pct == 82, "cell %d mV %d%%", g.mv, g.pct);
    CHECK(!g.discharging && g.charging && !g.full, "charging on USB");
    /* Unplugged, the frame awake on the cell. */
    fos_gauge_decode(3900, 61, -120, FOS_GAUGE_STATUS_BATTPRES | FOS_GAUGE_STATUS_DSG, &g);
    CHECK(g.discharging && !g.charging && g.current_ma == -120, "discharging %d mA", g.current_ma);
    /* Full on USB: neither charging nor discharging, and not "on battery". */
    fos_gauge_decode(4190, 100, 0, FOS_GAUGE_STATUS_BATTPRES | FOS_GAUGE_STATUS_FC, &g);
    CHECK(!g.discharging && !g.charging && g.full, "full on USB");
    /* No cell connected: the board reads like one without a battery. */
    fos_gauge_decode(3300, 50, 0, 0, &g);
    CHECK(!g.present && g.mv == 0 && g.pct == -1, "no cell is no battery: %d mV %d%%", g.mv, g.pct);
    CHECK(!g.discharging && !g.charging, "no cell, no flags");
    /* A gauge that has not read the cell yet (0 V), or a soc past 100. */
    fos_gauge_decode(0, 0, 0, FOS_GAUGE_STATUS_BATTPRES, &g);
    CHECK(g.pct == -1, "0 V is no reading");
    fos_gauge_decode(3700, 200, 0, FOS_GAUGE_STATUS_BATTPRES, &g);
    CHECK(g.pct == -1, "soc 200 is no reading");
}

int main(void)
{
    test_charger_decode();
    test_rtc_decode_and_encode();
    test_gauge_decode();
    printf("%s: %d checks, %d failures\n", g_failures ? "FAILED" : "ok", g_checks, g_failures);
    return g_failures == 0 ? 0 : 1;
}

#include "fos_rtc.h"

#include <string.h>

/* PCF8563 time registers, all BCD: 0x02 VL(7) seconds(6:0), 0x03 minutes,
 * 0x04 hours(5:0), 0x05 days(5:0), 0x06 weekdays(2:0), 0x07 century(7)
 * months(4:0), 0x08 years. The PCF85063 holds the same seven from 0x04:
 * OS(7) seconds(6:0) … months(4:0) with no century bit, years at 0x0A; its
 * hours are 5:0 in the 24-hour mode it powers up in (Control_1 12_24 = 0). */
#define RTC_VL_BIT 0x80 /* VL on the PCF8563, OS on the PCF85063 */
#define PCF8563_REG_TIME 0x02
#define PCF85063_REG_TIME 0x04

uint8_t fos_rtc_time_reg(fos_rtc_chip_t chip)
{
    return chip == FOS_RTC_PCF85063 ? PCF85063_REG_TIME : PCF8563_REG_TIME;
}

fos_rtc_chip_t fos_rtc_chip_from_name(const char *name)
{
    return name && strcmp(name, "pcf85063") == 0 ? FOS_RTC_PCF85063 : FOS_RTC_PCF8563;
}

const char *fos_rtc_chip_name(fos_rtc_chip_t chip)
{
    return chip == FOS_RTC_PCF85063 ? "pcf85063" : "pcf8563";
}

static int bcd_to_int(uint8_t v)
{
    int high = (v >> 4) & 0x0F, low = v & 0x0F;
    if (high > 9 || low > 9) return -1;
    return high * 10 + low;
}

static uint8_t int_to_bcd(int v)
{
    return (uint8_t)(((v / 10) << 4) | (v % 10));
}

/* Days since 1970-01-01 for a proleptic Gregorian date (Howard Hinnant's
 * days_from_civil), so the decode does not depend on the host's timegm. */
static int64_t days_from_civil(int y, int m, int d)
{
    y -= m <= 2;
    int64_t era = (y >= 0 ? y : y - 399) / 400;
    int64_t yoe = y - era * 400;
    int64_t doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
    int64_t doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    return era * 146097 + doe - 719468;
}

static void civil_from_days(int64_t z, int *y, int *m, int *d)
{
    z += 719468;
    int64_t era = (z >= 0 ? z : z - 146096) / 146097;
    int64_t doe = z - era * 146097;
    int64_t yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    int64_t yy = yoe + era * 400;
    int64_t doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    int64_t mp = (5 * doy + 2) / 153;
    *d = (int)(doy - (153 * mp + 2) / 5 + 1);
    *m = (int)(mp < 10 ? mp + 3 : mp - 9);
    *y = (int)(yy + (*m <= 2));
}

bool fos_rtc_decode(const uint8_t regs[FOS_RTC_TIME_LEN], time_t *out)
{
    if (regs[0] & RTC_VL_BIT) return false;
    int sec = bcd_to_int(regs[0] & 0x7F);
    int min = bcd_to_int(regs[1] & 0x7F);
    int hour = bcd_to_int(regs[2] & 0x3F);
    int day = bcd_to_int(regs[3] & 0x3F);
    int month = bcd_to_int(regs[5] & 0x1F);
    int year = bcd_to_int(regs[6]);
    if (sec < 0 || sec > 59 || min < 0 || min > 59 || hour < 0 || hour > 23 ||
        day < 1 || day > 31 || month < 1 || month > 12 || year < 0) {
        return false;
    }
    int64_t days = days_from_civil(2000 + year, month, day);
    *out = (time_t)(days * 86400 + hour * 3600 + min * 60 + sec);
    return true;
}

void fos_rtc_encode(time_t now, uint8_t regs[FOS_RTC_TIME_LEN])
{
    int64_t t = (int64_t)now;
    int64_t days = t / 86400;
    int64_t rem = t - days * 86400;
    if (rem < 0) {
        rem += 86400;
        days -= 1;
    }
    int y, m, d;
    civil_from_days(days, &y, &m, &d);
    if (y < 2000) y = 2000;
    if (y > 2099) y = 2099;
    /* 1970-01-01 was a Thursday (4); the chip counts Sunday as 0. */
    int weekday = (int)(((days % 7) + 11) % 7);
    regs[0] = int_to_bcd((int)(rem % 60));          /* VL / OS clear: the time is good */
    regs[1] = int_to_bcd((int)((rem / 60) % 60));
    regs[2] = int_to_bcd((int)(rem / 3600));
    regs[3] = int_to_bcd(d);
    regs[4] = (uint8_t)weekday;
    regs[5] = int_to_bcd(m);                         /* century bit clear = 20xx (unused on the PCF85063) */
    regs[6] = int_to_bcd(y - 2000);
}

#ifdef ESP_PLATFORM

#include <stdio.h>
#include <sys/time.h>

#include "esp_log.h"

#include "fos_board.h"
#include "fos_config.h"
#include "fos_i2c.h"
#include "frameos_nim.h"

static const char *TAG = "fos_rtc";
static bool s_loaded = false;
static uint8_t s_store_pending = 0; /* failed writes left to retry */
/* The boot's outcome, replayed by fos_rtc_log_status once upload is on. */
static char s_boot_line[160] = "";
static bool s_offset_checked = false;

/* Earlier than any time this firmware could have written: a clock that
 * reads before it holds something else (a PCF85063 written as a PCF8563
 * reads as 2000 or 2006) and is not taken. */
#define RTC_MIN_EPOCH 1767225600 /* 2026-01-01 00:00:00 UTC */

bool fos_rtc_present(void)
{
    return fos_i2c_present(FOS_I2C_PCF8563);
}

fos_rtc_chip_t fos_rtc_chip(void)
{
    return fos_rtc_chip_from_name(fos_board_rtc_chip(fos_config()->hardware_preset));
}

static void set_boot_not_set(const char *reason)
{
    snprintf(s_boot_line, sizeof(s_boot_line),
             "{\"event\":\"rtc\",\"source\":\"esp32\",\"action\":\"boot\",\"loaded\":false,\"reason\":\"%s\"}",
             reason);
}

/* A PCF85063's Offset register is 0x00 unless something calibrated it, and
 * nothing in FrameOS does: anything else is a PCF8563 write's seconds byte,
 * which runs the clock up to ±0.1 % fast or slow. Put it back once, and say
 * whether it was off (the time block was then written one register off too). */
static bool restore_offset(void)
{
    if (s_offset_checked) return false;
    uint8_t offset;
    if (fos_i2c_read(FOS_I2C_PCF8563, FOS_RTC_PCF85063_REG_OFFSET, &offset, 1) != ESP_OK) return false;
    s_offset_checked = true;
    if (offset == 0x00) return false;
    const uint8_t zero = 0x00;
    esp_err_t err = fos_i2c_write(FOS_I2C_PCF8563, FOS_RTC_PCF85063_REG_OFFSET, &zero, 1);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "offset restore failed (0x%x), retrying next read", (unsigned)err);
        s_offset_checked = false;
    } else {
        printf("rtc: pcf85063 offset register was 0x%02x, restored to 0x00\n", offset);
    }
    return true;
}

bool fos_rtc_load_time(void)
{
    fos_rtc_chip_t chip = fos_rtc_chip();
    if (chip == FOS_RTC_PCF85063 && fos_rtc_present() && restore_offset()) {
        printf("rtc: clock written by an older firmware, waiting for SNTP\n");
        set_boot_not_set("repaired");
        return false;
    }
    uint8_t regs[FOS_RTC_TIME_LEN];
    esp_err_t err = fos_i2c_read(FOS_I2C_PCF8563, fos_rtc_time_reg(chip), regs, sizeof(regs));
    if (err != ESP_OK) {
        if (err != ESP_ERR_NOT_FOUND) ESP_LOGW(TAG, "read failed: %s (0x%x)", esp_err_to_name(err), (unsigned)err);
        return false;
    }
    time_t now;
    if (!fos_rtc_decode(regs, &now)) {
        printf("rtc: clock not set (integrity flag), waiting for SNTP\n");
        set_boot_not_set("not_set");
        return false;
    }
    if (now < RTC_MIN_EPOCH) {
        printf("rtc: clock reads before 2026, waiting for SNTP\n");
        set_boot_not_set("stale");
        return false;
    }
    struct timeval tv = {.tv_sec = now, .tv_usec = 0};
    settimeofday(&tv, NULL);
    s_loaded = true;
    struct tm tm_utc;
    gmtime_r(&now, &tm_utc);
    printf("rtc: clock set from the %s: %04d-%02d-%02d %02d:%02d:%02d UTC\n",
           chip == FOS_RTC_PCF85063 ? "PCF85063" : "PCF8563", tm_utc.tm_year + 1900,
           tm_utc.tm_mon + 1, tm_utc.tm_mday, tm_utc.tm_hour, tm_utc.tm_min, tm_utc.tm_sec);
    snprintf(s_boot_line, sizeof(s_boot_line),
             "{\"event\":\"rtc\",\"source\":\"esp32\",\"action\":\"boot\",\"loaded\":true,"
             "\"time\":\"%04d-%02d-%02dT%02d:%02d:%02dZ\"}",
             tm_utc.tm_year + 1900, tm_utc.tm_mon + 1, tm_utc.tm_mday, tm_utc.tm_hour, tm_utc.tm_min, tm_utc.tm_sec);
    return true;
}

bool fos_rtc_time_loaded(void)
{
    return s_loaded;
}

void fos_rtc_log_status(void)
{
    if (s_boot_line[0]) frameos_nim_log_hook(s_boot_line);
}

esp_err_t fos_rtc_store_time(void)
{
    if (!fos_rtc_present()) return ESP_ERR_NOT_FOUND;
    time_t now = time(NULL);
    if (now < 1000000000) return ESP_ERR_INVALID_STATE;
    uint8_t regs[FOS_RTC_TIME_LEN];
    fos_rtc_encode(now, regs);
    fos_rtc_chip_t chip = fos_rtc_chip();
    if (chip == FOS_RTC_PCF85063) restore_offset();
    esp_err_t err = fos_i2c_write(FOS_I2C_PCF8563, fos_rtc_time_reg(chip), regs, sizeof(regs));
    if (err != ESP_OK) {
        /* The code as a number too: the WARN-only builds carry no error-name
         * table. The write is tried again on the next passes. */
        ESP_LOGW(TAG, "write failed (0x%x), retrying later", (unsigned)err);
        s_store_pending = 3;
    } else {
        s_store_pending = 0;
    }
    return err;
}

void fos_rtc_mark_dirty(void)
{
    if (fos_rtc_present() && s_store_pending == 0) s_store_pending = 3;
}

void fos_rtc_retry_pending(void)
{
    if (s_store_pending == 0) return;
    s_store_pending--;
    if (fos_rtc_store_time() == ESP_OK) printf("rtc: clock written\n");
}

#endif /* ESP_PLATFORM */

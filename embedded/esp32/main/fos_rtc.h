/*
 * The board's real-time clock: an NXP PCF8563 (I2C 0x51) with a backup cell,
 * on every Seeed reTerminal E-series model, or the NXP PCF85063 at the same
 * address on the Waveshare PhotoPainter (fos_board_rtc_chip says which). The ESP32's own clock survives
 * deep sleep but not a power cut or the rear switch; this one does, so a
 * frame that boots cold knows the time before Wi-Fi — the schedule and the
 * wake arithmetic run at once, and SNTP corrects the clock in the
 * background instead of holding the boot (fos_wifi_sync_time).
 *
 * At boot the clock is read and, when its integrity flag says the time is
 * good, set as the system time; every SNTP sync writes the system time back.
 * The BCD conversions are pure (main/tests/test_fos_i2c_devices.c); the I2C
 * goes through fos_i2c.c.
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>
#include <time.h>

typedef enum {
    FOS_RTC_PCF8563 = 0,
    FOS_RTC_PCF85063 = 1,
} fos_rtc_chip_t;

/* The seven time registers (seconds … years), as the chip holds them: from
 * 0x02 on the PCF8563, from 0x04 on the PCF85063, whose 0x02 is its Offset
 * (clock calibration) register and 0x03 a RAM byte. From there on the two
 * have the same shape — bit 7 of the seconds is the integrity flag (VL on
 * the PCF8563, OS on the PCF85063), the PCF8563's month carries a century
 * bit the PCF85063's leaves unused — so one decode serves both. */
#define FOS_RTC_TIME_LEN 7
#define FOS_RTC_PCF85063_REG_OFFSET 0x02

/* The register the time block starts at on that chip. */
uint8_t fos_rtc_time_reg(fos_rtc_chip_t chip);
/* The chip for fos_board_rtc_chip's spelling ("pcf85063"); anything else is
 * the PCF8563. */
fos_rtc_chip_t fos_rtc_chip_from_name(const char *name);
/* "pcf8563" or "pcf85063", as the console spells the chips. */
const char *fos_rtc_chip_name(fos_rtc_chip_t chip);

/* Decode the seven registers to a UTC epoch second. False when the
 * integrity flag (clock integrity lost: first power-up, backup cell flat) is
 * set or a field is out of range. Years are 2000-2099. */
bool fos_rtc_decode(const uint8_t regs[FOS_RTC_TIME_LEN], time_t *out);
/* Encode a UTC epoch second into the seven registers (integrity flag and
 * century bit clear). */
void fos_rtc_encode(time_t now, uint8_t regs[FOS_RTC_TIME_LEN]);

#ifdef ESP_PLATFORM
#include "esp_err.h"
bool fos_rtc_present(void);
/* Which clock the board's preset declares (fos_board_rtc_chip). */
fos_rtc_chip_t fos_rtc_chip(void);
/* Read the clock and set the system time from it. True when the time was
 * taken; false without a clock, with an unset one, or on an I2C error. On a
 * PCF85063 the first read also puts back a non-zero Offset register: firmware
 * that took the chip for a PCF8563 wrote its seconds there, and the time it
 * left one register off is not taken either. */
bool fos_rtc_load_time(void);
/* Whether fos_rtc_load_time set the clock this boot. */
bool fos_rtc_time_loaded(void);
/* Re-emit the boot's outcome as a `{"event":"rtc", …}` line into the log
 * ring once log upload is on (the boot read happens before Wi-Fi), so the
 * control plane's log says whether the clock came from the chip. */
void fos_rtc_log_status(void);
/* Write the system time to the clock now (the console's `i2c sync`, the
 * render pass). A write the chip NACKs is kept pending for the next pass. */
esp_err_t fos_rtc_store_time(void);
/* An SNTP sync happened: write the clock on the next render pass. Called
 * from the SNTP callback (lwIP's thread, a small stack) — no I2C there. */
void fos_rtc_mark_dirty(void);
/* A dirty or failed write, once per render pass (fos_client.c). */
void fos_rtc_retry_pending(void);
#endif

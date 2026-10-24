/*
 * The board's I2C peripheral buses and the chips FrameOS knows on them.
 *
 * A board preset (or `set i2c_buses sda=19,scl=20;sda=39,scl=40`) names up to
 * two buses; at boot each is probed for the three chips the reTerminal
 * E-series carry — a PCF8563 real-time clock at 0x51 (fos_rtc.c), a
 * Sensirion SHT4x climate sensor at 0x44 and a Silergy SY6974B charger at
 * 0x6b (fos_charger.c, a BQ2560x-compatible register map) — and what answers
 * is used. The console's `i2c` command prints the result and probes again.
 *
 * One mutex for every transaction: the render task (the power decision), the
 * HTTP server (/status), the console and the cloud client all read.
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

typedef enum {
    FOS_I2C_PCF8563 = 0, /* real-time clock, 0x51 */
    FOS_I2C_SHT4X = 1,   /* temperature / humidity, 0x44 */
    FOS_I2C_SY6974B = 2, /* battery charger, 0x6b */
    FOS_I2C_CHIP_COUNT
} fos_i2c_chip_t;

/* Bring up the configured buses and probe them. Safe to call again (the
 * console's rescan, a settings push): tears the old buses down first. */
esp_err_t fos_i2c_init(void);
/* Whether the chip answered on one of the buses. */
bool fos_i2c_present(fos_i2c_chip_t chip);
/* Register reads and writes: a one-byte register address, then `len` bytes. */
esp_err_t fos_i2c_read(fos_i2c_chip_t chip, uint8_t reg, uint8_t *buf, size_t len);
esp_err_t fos_i2c_write(fos_i2c_chip_t chip, uint8_t reg, const uint8_t *buf, size_t len);
/* The chip's name as the console and the hardware report spell it. */
const char *fos_i2c_chip_name(fos_i2c_chip_t chip);
/* One line: `sda19/scl20: pcf8563 sht4x; sda39/scl40: sy6974b`, or "none". */
void fos_i2c_summary(char *out, size_t out_len);

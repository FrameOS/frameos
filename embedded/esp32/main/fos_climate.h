/*
 * The climate sensor: a Sensirion SHT4x (I2C 0x44) on every Seeed reTerminal
 * board. FrameOS reads it for one thing so far: the reTerminal E1003's IT8951
 * picks its waveform by temperature and has no sensor of its own, so the
 * display asks this one before each refresh (fos_display_set_temperature_hook,
 * components/frameos_display/it8951.c), as Seeed's own firmware does.
 *
 * The decode is pure (main/tests/test_fos_i2c_devices.c argues with it); the
 * read goes through fos_i2c.c.
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* Measure temperature and humidity, high repeatability: six bytes back
 * after at most 8.3 ms (SHT4x datasheet, "Commands"). */
#define FOS_CLIMATE_CMD_MEASURE 0xFD
#define FOS_CLIMATE_MEASURE_MS 10

/* The sensor's CRC-8 over each two-byte word (polynomial 0x31, init 0xFF). */
uint8_t fos_climate_crc8(const uint8_t *data, size_t len);

/* A measurement's six bytes (temperature word, CRC, humidity word, CRC) to
 * hundredths of a degree Celsius and of a percent of relative humidity,
 * humidity clamped to 0..100 %. False when a CRC does not match. Pure. */
bool fos_climate_decode(const uint8_t raw[6], int *centi_celsius, int *centi_humidity);

#ifdef ESP_PLATFORM
#include "esp_err.h"
/* One measurement. ESP_ERR_NOT_FOUND without a sensor, ESP_ERR_INVALID_CRC
 * for a garbled answer. Either output may be NULL. */
esp_err_t fos_climate_read(int *centi_celsius, int *centi_humidity);
#endif

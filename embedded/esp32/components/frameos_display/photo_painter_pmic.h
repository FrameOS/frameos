#pragma once

#include "esp_err.h"

/* Turns on the panel's supply (ALDO4 = EPD_VCC). `lend_bus` returns the
 * I2C bus already open on the given pins (an `i2c_master_bus_handle_t`), or
 * NULL when there is none and the PMIC may open its own. */
esp_err_t fos_photo_painter_enable_epd_power(void *(*lend_bus)(int sda, int scl));

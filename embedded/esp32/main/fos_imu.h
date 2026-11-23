/*
 * The board's accelerometer: a QST QMI8658 six-axis IMU at I2C 0x6b on the
 * Waveshare ESP32-S3-Touch-AMOLED-1.75 (fos_i2c.c tells it from the
 * reTerminal charger at the same address by its WHO_AM_I). FrameOS runs the
 * accelerometer alone, +/-4 g at 62.5 Hz, the gyroscope off: which way is
 * down, for the console's `imu` and the hardware report, nothing a scene
 * hears yet.
 *
 * The decode is pure (main/tests/test_fos_i2c_devices.c); the reads go
 * through fos_i2c.c.
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

/* QMI8658 registers (QST's datasheet; SensorLib's SensorQMI8658_Reg.hpp). */
#define FOS_QMI8658_REG_WHO_AM_I 0x00 /* 0x05 */
#define FOS_QMI8658_REG_CTRL1 0x02    /* bit 6: register address auto-increment */
#define FOS_QMI8658_REG_CTRL2 0x03    /* accelerometer range [6:4], output rate [3:0] */
#define FOS_QMI8658_REG_CTRL7 0x08    /* bit 0 accelerometer on, bit 1 gyroscope on */
#define FOS_QMI8658_REG_AX_L 0x35     /* x, y, z: six bytes, little-endian */
#define FOS_QMI8658_CTRL1_AUTO_INCREMENT (1u << 6)
/* +/-4 g (range 1), 62.5 Hz (rate 7). */
#define FOS_QMI8658_CTRL2_4G_62HZ ((1u << 4) | 0x07u)
#define FOS_QMI8658_CTRL7_ACCEL (1u << 0)

/* The six data bytes as read from FOS_QMI8658_REG_AX_L, at +/-4 g, in
 * thousandths of g. Pure. */
void fos_imu_decode(const uint8_t raw[6], int *x_mg, int *y_mg, int *z_mg);

#ifdef ESP_PLATFORM
#include "esp_err.h"
/* Once at boot, after fos_i2c_init: the accelerometer on, if there is one.
 * ESP_ERR_NOT_FOUND without. */
esp_err_t fos_imu_init(void);
bool fos_imu_present(void);
/* The latest sample, thousandths of g. */
esp_err_t fos_imu_read(int *x_mg, int *y_mg, int *z_mg);
#endif

/*
 * The board's accelerometer (docs/accelerometer.md): a QST QMI8658 six-axis
 * IMU at I2C 0x6b on the Waveshare ESP32-S3-Touch-AMOLED-1.75 (fos_i2c.c
 * tells it from the reTerminal charger at the same address by its WHO_AM_I),
 * or an ST LSM6DS3TR-C at 0x6a on the Seeed reTerminal Sticky. FrameOS runs
 * the accelerometer alone at +/-4 g, the gyroscope off.
 *
 * A task reads it 50 times a second while a scene reads it
 * (frameos.accelerometer(): fos_imu_gravity) and 25 times otherwise, turns
 * the chip's axes into the panel's (the board's map, or `imu_axes`), and
 * hands the reading to fos_motion.c: the gestures go to the scene through the
 * dispatcher (`tilt`, `flick`, `shake`, `orientation`, origin `driver`) and
 * the upright rotation to auto-rotate (fos_rotation.c).
 *
 * The decodes are pure (main/tests/test_fos_i2c_devices.c); the reads go
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

/* LSM6DS3TR-C registers (ST's datasheet DS12156). */
#define FOS_LSM6DS3_REG_WHO_AM_I 0x0f  /* 0x6a */
#define FOS_LSM6DS3_WHO_AM_I 0x6a
#define FOS_LSM6DS3_REG_CTRL1_XL 0x10  /* output rate [7:4], range [3:2] */
#define FOS_LSM6DS3_REG_CTRL2_G 0x11   /* the gyroscope: 0 is off */
#define FOS_LSM6DS3_REG_CTRL3_C 0x12   /* bit 6 BDU, bit 2 IF_INC */
#define FOS_LSM6DS3_REG_OUTX_L_XL 0x28 /* x, y, z: six bytes, little-endian */
/* 104 Hz (0100), +/-4 g (10). */
#define FOS_LSM6DS3_CTRL1_XL_4G_104HZ 0x48u
/* Block data update (a sample's bytes from one sample) and auto-increment. */
#define FOS_LSM6DS3_CTRL3_C_BDU_INC 0x44u

/* The six data bytes as either chip sends them (x, y, z, little-endian), at
 * +/-4 g, in thousandths of g. Pure. */
void fos_imu_decode(const uint8_t raw[6], int *x_mg, int *y_mg, int *z_mg);

/* The board's accelerometer axes on its panel, as fos_motion_parse_axes reads
 * them; "x=x,y=y,z=z" for a board not in the table. Pure. */
const char *fos_imu_board_axes(const char *hardware_preset);

#ifdef ESP_PLATFORM
#include "esp_err.h"
/* Once at boot, after fos_i2c_init: the accelerometer on and its task
 * started, if there is one. ESP_ERR_NOT_FOUND without. */
esp_err_t fos_imu_init(void);
bool fos_imu_present(void);
/* "qmi8658", "lsm6ds3", or "" */
const char *fos_imu_chip(void);
/* The latest sample as the chip reports it, thousandths of g, read now. */
esp_err_t fos_imu_read(int *x_mg, int *y_mg, int *z_mg);
/* Which way gravity pulls along the picture's axes as it is drawn now
 * (fos_rotation), thousandths of g: frameos.accelerometer(). False without
 * an accelerometer or before its first reading. Any task. */
bool fos_imu_gravity(int *x_mg, int *y_mg, int *z_mg);
/* The settled position (fos_position_t) and the rotation that stands the
 * picture upright, -1 unknown: the console's `imu`. */
int fos_imu_position(void);
int fos_imu_upright_rotate(void);
/* `imu_axes` changed (the console): the next reading uses it. */
void fos_imu_axes_changed(void);
#endif

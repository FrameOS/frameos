#include "fos_imu.h"

#include <string.h>

void fos_imu_decode(const uint8_t raw[6], int *x_mg, int *y_mg, int *z_mg)
{
    int16_t x = (int16_t)(raw[0] | (raw[1] << 8));
    int16_t y = (int16_t)(raw[2] | (raw[3] << 8));
    int16_t z = (int16_t)(raw[4] | (raw[5] << 8));
    /* 4 g over the int16 range (the LSM6DS3's 0.122 mg a step is the same). */
    if (x_mg) *x_mg = (int)x * 4000 / 32768;
    if (y_mg) *y_mg = (int)y * 4000 / 32768;
    if (z_mg) *z_mg = (int)z * 4000 / 32768;
}

/* Where each board's chip sits against its panel: the panel's x, y and z
 * (towards the unrotated panel's right, its bottom, out of the glass) as
 * the chip's axes. A board not listed reads its chip's axes as the panel's.
 * `set imu_axes` overrides either on a frame (docs/accelerometer.md "Axes"),
 * and the console's `imu` says which way down is, to check it by turning the
 * frame: upright it must say y=+1000, face up z=-1000.
 *
 * What the bench showed (2026-11-28, both boards standing on an edge): the
 * Sticky, standing in the portrait its preset draws (rotation 270), had its
 * chip's -x up, which is the panel's x as the chip's x; the AMOLED, standing
 * with its picture upright at 0, had its chip's +x up, which is the panel's
 * y as the chip's -x. The z rows assume each chip sits behind the glass,
 * facing away from it, and the remaining axis follows from both frames'
 * handedness (the chip's is right-handed, the panel's x right, y down, z out
 * is not). Tilts, flicks and shakes come right whatever the map; which side a
 * tilt names, `orientation` and auto-rotate follow it. */
static const struct {
    const char *preset;
    const char *axes;
} k_board_axes[] = {
    {"waveshare_esp32_s3_touch_amoled_1_75", "x=y,y=-x,z=-z"},
    {"seeed_reterminal_sticky", "x=x,y=y,z=-z"},
};

const char *fos_imu_board_axes(const char *hardware_preset)
{
    if (hardware_preset) {
        for (size_t i = 0; i < sizeof(k_board_axes) / sizeof(k_board_axes[0]); i++) {
            if (strcmp(hardware_preset, k_board_axes[i].preset) == 0) return k_board_axes[i].axes;
        }
    }
    return "x=x,y=y,z=z";
}

#ifdef ESP_PLATFORM
#include <stdio.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "esp_log.h"
#include "esp_timer.h"

#include "fos_config.h"
#include "fos_events.h"
#include "fos_i2c.h"
#include "fos_motion.h"
#include "fos_rotation.h"

static const char *TAG = "fos_imu";

/* A scene that read the accelerometer within this long is reading it every
 * frame: the task reads twice as often for it. */
#define FAST_FOR_US (3 * 1000 * 1000)
#define FAST_PERIOD_MS 20
#define SLOW_PERIOD_MS 40
#define IMU_TASK_STACK 5120

static fos_i2c_chip_t s_chip = FOS_I2C_CHIP_COUNT;
static fos_motion_t s_motion;
static fos_motion_axes_t s_axes;
static volatile bool s_axes_changed = true;
static portMUX_TYPE s_lock = portMUX_INITIALIZER_UNLOCKED;
static int64_t s_read_at_us = 0;
static TaskHandle_t s_task = NULL;

static esp_err_t set_bits(uint8_t reg, uint8_t bits)
{
    uint8_t value = 0;
    esp_err_t err = fos_i2c_read(FOS_I2C_QMI8658, reg, &value, 1);
    if (err != ESP_OK) return err;
    value |= bits;
    return fos_i2c_write(FOS_I2C_QMI8658, reg, &value, 1);
}

static esp_err_t start_qmi8658(void)
{
    uint8_t ctrl2 = FOS_QMI8658_CTRL2_4G_62HZ;
    esp_err_t err = set_bits(FOS_QMI8658_REG_CTRL1, FOS_QMI8658_CTRL1_AUTO_INCREMENT);
    if (err == ESP_OK) err = fos_i2c_write(FOS_I2C_QMI8658, FOS_QMI8658_REG_CTRL2, &ctrl2, 1);
    if (err == ESP_OK) err = set_bits(FOS_QMI8658_REG_CTRL7, FOS_QMI8658_CTRL7_ACCEL);
    return err;
}

static esp_err_t start_lsm6ds3(void)
{
    uint8_t who = 0;
    esp_err_t err = fos_i2c_read(FOS_I2C_LSM6DS3, FOS_LSM6DS3_REG_WHO_AM_I, &who, 1);
    if (err != ESP_OK) return err;
    if (who != FOS_LSM6DS3_WHO_AM_I) {
        ESP_LOGW(TAG, "a chip at 0x6a says WHO_AM_I 0x%02x, not an LSM6DS3TR-C", who);
        return ESP_ERR_NOT_FOUND;
    }
    uint8_t ctrl3 = FOS_LSM6DS3_CTRL3_C_BDU_INC, ctrl1 = FOS_LSM6DS3_CTRL1_XL_4G_104HZ, off = 0;
    err = fos_i2c_write(FOS_I2C_LSM6DS3, FOS_LSM6DS3_REG_CTRL3_C, &ctrl3, 1);
    if (err == ESP_OK) err = fos_i2c_write(FOS_I2C_LSM6DS3, FOS_LSM6DS3_REG_CTRL2_G, &off, 1);
    if (err == ESP_OK) err = fos_i2c_write(FOS_I2C_LSM6DS3, FOS_LSM6DS3_REG_CTRL1_XL, &ctrl1, 1);
    return err;
}

bool fos_imu_present(void)
{
    return s_chip != FOS_I2C_CHIP_COUNT;
}

const char *fos_imu_chip(void)
{
    return fos_imu_present() ? fos_i2c_chip_name(s_chip) : "";
}

esp_err_t fos_imu_read(int *x_mg, int *y_mg, int *z_mg)
{
    if (!fos_imu_present()) return ESP_ERR_INVALID_STATE;
    uint8_t raw[6];
    uint8_t reg = s_chip == FOS_I2C_QMI8658 ? FOS_QMI8658_REG_AX_L : FOS_LSM6DS3_REG_OUTX_L_XL;
    esp_err_t err = fos_i2c_read(s_chip, reg, raw, sizeof(raw));
    if (err == ESP_OK) fos_imu_decode(raw, x_mg, y_mg, z_mg);
    return err;
}

void fos_imu_axes_changed(void)
{
    s_axes_changed = true;
}

static void load_axes(void)
{
    const fos_config_t *config = fos_config();
    if (config->imu_axes[0] && fos_motion_parse_axes(config->imu_axes, &s_axes)) return;
    fos_motion_parse_axes(fos_imu_board_axes(config->hardware_preset), &s_axes);
}

bool fos_imu_gravity(int *x_mg, int *y_mg, int *z_mg)
{
    if (!fos_imu_present()) return false;
    __atomic_store_n(&s_read_at_us, esp_timer_get_time(), __ATOMIC_RELAXED);
    int g[3];
    portENTER_CRITICAL(&s_lock);
    bool ok = fos_motion_gravity(&s_motion, fos_rotation(), g);
    portEXIT_CRITICAL(&s_lock);
    if (!ok) return false;
    *x_mg = g[0];
    *y_mg = g[1];
    *z_mg = g[2];
    return true;
}

int fos_imu_position(void)
{
    return s_motion.position;
}

int fos_imu_upright_rotate(void)
{
    return fos_motion_upright_rotate(&s_motion);
}

static void imu_task(void *arg)
{
    (void)arg;
    TickType_t last = xTaskGetTickCount();
    int failures = 0;
    for (;;) {
        int64_t now_us = esp_timer_get_time();
        bool fast = now_us - __atomic_load_n(&s_read_at_us, __ATOMIC_RELAXED) < FAST_FOR_US;
        vTaskDelayUntil(&last, pdMS_TO_TICKS(fast ? FAST_PERIOD_MS : SLOW_PERIOD_MS));
        if (s_axes_changed) {
            /* Another map is another frame of reference: what was learnt in
             * the old one (the rest, the position) would read as a tilt and
             * a turn at the next reading (the bench, 2026-11-28). */
            s_axes_changed = false;
            load_axes();
            portENTER_CRITICAL(&s_lock);
            fos_motion_init(&s_motion);
            portEXIT_CRITICAL(&s_lock);
        }
        int chip[3], panel[3];
        if (fos_imu_read(&chip[0], &chip[1], &chip[2]) != ESP_OK) {
            /* A bus another task holds too long, or a chip gone: say so once
             * in a while, never stop. */
            if (++failures % 250 == 1) ESP_LOGW(TAG, "accelerometer read failed (%d)", failures);
            continue;
        }
        fos_motion_apply_axes(&s_axes, chip, panel);
        const fos_config_t *config = fos_config();
        fos_motion_event_t events[FOS_MOTION_EVENTS_MAX];
        portENTER_CRITICAL(&s_lock);
        int n = fos_motion_step(&s_motion, panel, (uint32_t)(now_us / 1000), fos_rotation(), config->rotate, events);
        int upright = fos_motion_upright_rotate(&s_motion);
        portEXIT_CRITICAL(&s_lock);
        for (int i = 0; i < n; i++) {
            char payload[96];
            fos_motion_payload(&events[i], payload, sizeof(payload));
            /* From this task the scene's half is queued for the render task
             * (fos_events_defer), or relayed to the plane on a frame it
             * renders. */
            fos_events_dispatch(FOS_ORIGIN_DRIVER, fos_motion_event_name(events[i].kind), payload);
        }
        /* Every reading, auto-rotate on or off: switching it either way turns
         * the picture at the next sample, a still scene included. */
        fos_rotation_follow(upright);
    }
}

esp_err_t fos_imu_init(void)
{
    if (s_task) return ESP_OK;
    s_chip = FOS_I2C_CHIP_COUNT;
    esp_err_t err = ESP_ERR_NOT_FOUND;
    if (fos_i2c_present(FOS_I2C_QMI8658) && (err = start_qmi8658()) == ESP_OK) {
        s_chip = FOS_I2C_QMI8658;
    } else if (fos_i2c_present(FOS_I2C_LSM6DS3) && (err = start_lsm6ds3()) == ESP_OK) {
        s_chip = FOS_I2C_LSM6DS3;
    }
    if (!fos_imu_present()) return err;
    fos_motion_init(&s_motion);
    load_axes();
    s_axes_changed = false;
    if (xTaskCreate(imu_task, "fos_imu", IMU_TASK_STACK, NULL, 4, &s_task) != pdPASS) {
        ESP_LOGW(TAG, "no task for the accelerometer");
        s_chip = FOS_I2C_CHIP_COUNT;
        return ESP_ERR_NO_MEM;
    }
    ESP_LOGI(TAG, "accelerometer: %s, axes %s", fos_imu_chip(),
             fos_config()->imu_axes[0] ? fos_config()->imu_axes : fos_imu_board_axes(fos_config()->hardware_preset));
    return ESP_OK;
}
#endif

#include "fos_imu.h"

void fos_imu_decode(const uint8_t raw[6], int *x_mg, int *y_mg, int *z_mg)
{
    int16_t x = (int16_t)(raw[0] | (raw[1] << 8));
    int16_t y = (int16_t)(raw[2] | (raw[3] << 8));
    int16_t z = (int16_t)(raw[4] | (raw[5] << 8));
    /* 4 g over the int16 range. */
    if (x_mg) *x_mg = (int)x * 4000 / 32768;
    if (y_mg) *y_mg = (int)y * 4000 / 32768;
    if (z_mg) *z_mg = (int)z * 4000 / 32768;
}

#ifdef ESP_PLATFORM
#include "fos_i2c.h"

static bool s_ready = false;

static esp_err_t set_bits(uint8_t reg, uint8_t bits)
{
    uint8_t value = 0;
    esp_err_t err = fos_i2c_read(FOS_I2C_QMI8658, reg, &value, 1);
    if (err != ESP_OK) return err;
    value |= bits;
    return fos_i2c_write(FOS_I2C_QMI8658, reg, &value, 1);
}

esp_err_t fos_imu_init(void)
{
    s_ready = false;
    if (!fos_i2c_present(FOS_I2C_QMI8658)) return ESP_ERR_NOT_FOUND;
    uint8_t ctrl2 = FOS_QMI8658_CTRL2_4G_62HZ;
    esp_err_t err = set_bits(FOS_QMI8658_REG_CTRL1, FOS_QMI8658_CTRL1_AUTO_INCREMENT);
    if (err == ESP_OK) err = fos_i2c_write(FOS_I2C_QMI8658, FOS_QMI8658_REG_CTRL2, &ctrl2, 1);
    if (err == ESP_OK) err = set_bits(FOS_QMI8658_REG_CTRL7, FOS_QMI8658_CTRL7_ACCEL);
    s_ready = err == ESP_OK;
    return err;
}

bool fos_imu_present(void)
{
    return s_ready;
}

esp_err_t fos_imu_read(int *x_mg, int *y_mg, int *z_mg)
{
    if (!s_ready) return ESP_ERR_INVALID_STATE;
    uint8_t raw[6];
    esp_err_t err = fos_i2c_read(FOS_I2C_QMI8658, FOS_QMI8658_REG_AX_L, raw, sizeof(raw));
    if (err == ESP_OK) fos_imu_decode(raw, x_mg, y_mg, z_mg);
    return err;
}
#endif

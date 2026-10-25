#include "fos_climate.h"

uint8_t fos_climate_crc8(const uint8_t *data, size_t len)
{
    uint8_t crc = 0xFF;
    for (size_t i = 0; i < len; i++) {
        crc ^= data[i];
        for (int bit = 0; bit < 8; bit++) {
            crc = (crc & 0x80) ? (uint8_t)((crc << 1) ^ 0x31) : (uint8_t)(crc << 1);
        }
    }
    return crc;
}

bool fos_climate_decode(const uint8_t raw[6], int *centi_celsius, int *centi_humidity)
{
    if (fos_climate_crc8(raw, 2) != raw[2] || fos_climate_crc8(raw + 3, 2) != raw[5]) return false;
    int32_t t_ticks = (int32_t)((raw[0] << 8) | raw[1]);
    int32_t rh_ticks = (int32_t)((raw[3] << 8) | raw[4]);
    /* T = -45 + 175 * ticks / 65535; RH = -6 + 125 * ticks / 65535. */
    int32_t centi_t = -4500 + (int32_t)(((int64_t)17500 * t_ticks + 32767) / 65535);
    int32_t centi_rh = -600 + (int32_t)(((int64_t)12500 * rh_ticks + 32767) / 65535);
    if (centi_rh < 0) centi_rh = 0;
    if (centi_rh > 10000) centi_rh = 10000;
    if (centi_celsius) *centi_celsius = (int)centi_t;
    if (centi_humidity) *centi_humidity = (int)centi_rh;
    return true;
}

#ifdef ESP_PLATFORM
#include "fos_i2c.h"

esp_err_t fos_climate_read(int *centi_celsius, int *centi_humidity)
{
    uint8_t raw[6];
    esp_err_t err = fos_i2c_command_read(FOS_I2C_SHT4X, FOS_CLIMATE_CMD_MEASURE, FOS_CLIMATE_MEASURE_MS,
                                         raw, sizeof(raw));
    if (err != ESP_OK) return err;
    return fos_climate_decode(raw, centi_celsius, centi_humidity) ? ESP_OK : ESP_ERR_INVALID_CRC;
}
#endif /* ESP_PLATFORM */

#include "fos_gauge.h"

#include <string.h>

void fos_gauge_decode(uint16_t voltage_mv, uint16_t soc, int16_t current_ma, uint16_t status,
                      fos_gauge_status_t *out)
{
    memset(out, 0, sizeof(*out));
    out->present = (status & FOS_GAUGE_STATUS_BATTPRES) != 0;
    out->mv = out->present ? voltage_mv : 0;
    /* A gauge with no cell, or one that has not taken a first reading,
     * reports no charge: the caller's "no battery" path, not 0 %. */
    out->pct = out->present && voltage_mv > 0 && soc <= 100 ? (int)soc : -1;
    out->current_ma = current_ma;
    out->discharging = out->present && (status & FOS_GAUGE_STATUS_DSG) != 0;
    out->full = out->present && (status & FOS_GAUGE_STATUS_FC) != 0;
    /* Charging is current flowing into the cell. The DSG flag alone is not
     * the inverse: a full cell on USB neither charges nor discharges. */
    out->charging = out->present && current_ma > 0;
}

#ifdef ESP_PLATFORM
#include "fos_i2c.h"

bool fos_gauge_present(void)
{
    return fos_i2c_present(FOS_I2C_BQ27220);
}

static esp_err_t read_word(uint8_t command, uint16_t *out)
{
    uint8_t raw[2];
    esp_err_t err = fos_i2c_read(FOS_I2C_BQ27220, command, raw, sizeof(raw));
    if (err != ESP_OK) return err;
    *out = (uint16_t)(raw[0] | (raw[1] << 8));
    return ESP_OK;
}

esp_err_t fos_gauge_read(fos_gauge_status_t *out)
{
    if (!out) return ESP_ERR_INVALID_ARG;
    memset(out, 0, sizeof(*out));
    out->pct = -1;
    uint16_t voltage = 0, soc = 0, current = 0, status = 0;
    esp_err_t err = read_word(FOS_GAUGE_CMD_VOLTAGE, &voltage);
    if (err == ESP_OK) err = read_word(FOS_GAUGE_CMD_STATE_OF_CHARGE, &soc);
    if (err == ESP_OK) err = read_word(FOS_GAUGE_CMD_CURRENT, &current);
    if (err == ESP_OK) err = read_word(FOS_GAUGE_CMD_BATTERY_STATUS, &status);
    if (err != ESP_OK) return err;
    fos_gauge_decode(voltage, soc, (int16_t)current, status, out);
    return ESP_OK;
}
#endif /* ESP_PLATFORM */

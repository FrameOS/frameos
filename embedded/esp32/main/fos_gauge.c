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

/* REG01: [6:5] 0 standby, 1 charging, 2 discharging; [2:0] 0 trickle,
 * 1 pre-charge, 2 constant current, 3 constant voltage, 4 done, 5 idle. */
#define AXP2101_STATUS2_DIRECTION(v) (((v) >> 5) & 0x03)
#define AXP2101_STATUS2_CHARGE_STATE(v) ((v) & 0x07)
#define AXP2101_DIRECTION_CHARGING 1
#define AXP2101_CHARGE_DONE 4

void fos_gauge_decode_axp2101(uint8_t status1, uint8_t status2, uint8_t vbat_h, uint8_t vbat_l,
                              uint8_t soc, fos_gauge_status_t *out)
{
    memset(out, 0, sizeof(*out));
    out->present = (status1 & FOS_AXP2101_STATUS1_BATTERY) != 0;
    int mv = ((vbat_h & 0x1F) << 8) | vbat_l;
    out->mv = out->present ? mv : 0;
    /* As the BQ27220's: no cell, or an ADC that has not sampled yet, is no
     * charge reading rather than 0 %. */
    out->pct = out->present && mv > 0 && soc <= 100 ? (int)soc : -1;
    bool vbus_good = (status1 & FOS_AXP2101_STATUS1_VBUS_GOOD) != 0;
    /* Not the direction bits: a board on USB drawing more than the input
     * limit tops up from the cell and reads "discharging" for a moment, and
     * that frame is still on its desk, not on battery. */
    out->discharging = out->present && !vbus_good;
    out->charging = out->present && vbus_good &&
                    AXP2101_STATUS2_DIRECTION(status2) == AXP2101_DIRECTION_CHARGING;
    out->full = out->present && vbus_good && AXP2101_STATUS2_CHARGE_STATE(status2) == AXP2101_CHARGE_DONE;
}

#ifdef ESP_PLATFORM
#include "fos_i2c.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

/* Something else could answer at 0x34: only a chip that says it is an
 * AXP2101 gets the enable writes below. -1 not asked yet. */
static int8_t s_axp2101_ok = -1;
static bool s_axp2101_enabled = false;

static bool axp2101_present(void)
{
    if (!fos_i2c_present(FOS_I2C_AXP2101)) return false;
    if (s_axp2101_ok < 0) {
        uint8_t id = 0;
        if (fos_i2c_read(FOS_I2C_AXP2101, FOS_AXP2101_REG_IC_TYPE, &id, 1) != ESP_OK) return false;
        s_axp2101_ok = id == FOS_AXP2101_CHIP_ID ? 1 : 0;
    }
    return s_axp2101_ok == 1;
}

bool fos_gauge_present(void)
{
    return fos_i2c_present(FOS_I2C_BQ27220) || axp2101_present();
}

const char *fos_gauge_chip_name(void)
{
    if (fos_i2c_present(FOS_I2C_BQ27220)) return "bq27220";
    return axp2101_present() ? "axp2101" : "none";
}

/* Set `bit` in `reg` unless it already is. Whether it wrote. */
static esp_err_t axp2101_set_bit(uint8_t reg, uint8_t bit, bool *wrote)
{
    uint8_t value = 0;
    esp_err_t err = fos_i2c_read(FOS_I2C_AXP2101, reg, &value, 1);
    if (err != ESP_OK || (value & bit)) return err;
    value |= bit;
    err = fos_i2c_write(FOS_I2C_AXP2101, reg, &value, 1);
    if (err == ESP_OK) *wrote = true;
    return err;
}

/* The PMIC keeps them switched on through the ESP32's deep sleep, so on most
 * wakes this is three reads and no write. */
static esp_err_t axp2101_enable(void)
{
    if (s_axp2101_enabled) return ESP_OK;
    bool wrote = false;
    esp_err_t err = axp2101_set_bit(FOS_AXP2101_REG_ADC_CTRL, FOS_AXP2101_ADC_VBAT_ENABLE, &wrote);
    if (err == ESP_OK) err = axp2101_set_bit(FOS_AXP2101_REG_GAUGE_CTRL, FOS_AXP2101_GAUGE_ENABLE, &wrote);
    /* Without detection REG00 never says a cell is there, and the gauge's
     * numbers read as "no battery" (the PhotoPainter, 2026-11-06). */
    if (err == ESP_OK) err = axp2101_set_bit(FOS_AXP2101_REG_BATTERY_DET, FOS_AXP2101_BATTERY_DET_ENABLE, &wrote);
    if (err != ESP_OK) return err;
    /* A freshly enabled ADC has no sample yet: give it one conversion. */
    if (wrote) vTaskDelay(pdMS_TO_TICKS(20));
    s_axp2101_enabled = true;
    return ESP_OK;
}

static esp_err_t axp2101_read(fos_gauge_status_t *out)
{
    esp_err_t err = axp2101_enable();
    uint8_t status[2] = {0}, vbat[2] = {0}, soc = 0;
    if (err == ESP_OK) err = fos_i2c_read(FOS_I2C_AXP2101, FOS_AXP2101_REG_STATUS1, status, sizeof(status));
    if (err == ESP_OK) err = fos_i2c_read(FOS_I2C_AXP2101, FOS_AXP2101_REG_VBAT_H, vbat, sizeof(vbat));
    if (err == ESP_OK) err = fos_i2c_read(FOS_I2C_AXP2101, FOS_AXP2101_REG_BATTERY_PCT, &soc, 1);
    if (err != ESP_OK) return err;
    fos_gauge_decode_axp2101(status[0], status[1], vbat[0], vbat[1], soc, out);
    return ESP_OK;
}

esp_err_t fos_gauge_axp2101_raw(uint8_t out[8])
{
    static const uint8_t regs[8] = {
        FOS_AXP2101_REG_STATUS1, FOS_AXP2101_REG_STATUS2, FOS_AXP2101_REG_GAUGE_CTRL,
        FOS_AXP2101_REG_ADC_CTRL, FOS_AXP2101_REG_VBAT_H, FOS_AXP2101_REG_VBAT_L,
        FOS_AXP2101_REG_BATTERY_DET, FOS_AXP2101_REG_BATTERY_PCT,
    };
    if (!axp2101_present()) return ESP_ERR_NOT_FOUND;
    for (int i = 0; i < 8; i++) {
        esp_err_t err = fos_i2c_read(FOS_I2C_AXP2101, regs[i], &out[i], 1);
        if (err != ESP_OK) return err;
    }
    return ESP_OK;
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
    if (!fos_i2c_present(FOS_I2C_BQ27220)) {
        return axp2101_present() ? axp2101_read(out) : ESP_ERR_NOT_FOUND;
    }
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

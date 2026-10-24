#include "fos_charger.h"

#include <string.h>

/* REG08: VBUS_STAT[7:5] CHRG_STAT[4:3] PG_STAT[2] THERM_STAT[1] VSYS_STAT[0].
 * REG0A: VBUS_GD[7] VINDPM_STAT[6] IINDPM_STAT[5] … (BQ25601 / SY6974B). */
#define REG08_VBUS_STAT(v) (((v) >> 5) & 0x07)
#define REG08_CHRG_STAT(v) (((v) >> 3) & 0x03)
#define REG08_PG_STAT(v) (((v) >> 2) & 0x01)
#define REG0A_VBUS_GD(v) (((v) >> 7) & 0x01)

void fos_charger_decode(uint8_t reg08, uint8_t reg0a, fos_charger_status_t *out)
{
    memset(out, 0, sizeof(*out));
    out->vbus_stat = (uint8_t)REG08_VBUS_STAT(reg08);
    out->chrg_stat = (uint8_t)REG08_CHRG_STAT(reg08);
    /* Powered from the input when the input is good (PG) or VBUS is judged
     * good; an OTG source (7) is the board driving VBUS, not the other way.
     * A bare VBUS_STAT of USB/adapter without PG is an input still being
     * qualified: not yet power to count on. */
    out->usb_power = out->vbus_stat != 7 && (REG08_PG_STAT(reg08) || REG0A_VBUS_GD(reg0a));
    out->charging = out->usb_power && (out->chrg_stat == 1 || out->chrg_stat == 2);
    out->charge_done = out->usb_power && out->chrg_stat == 3;
}

#ifdef ESP_PLATFORM

#include "fos_i2c.h"

bool fos_charger_present(void)
{
    return fos_i2c_present(FOS_I2C_SY6974B);
}

esp_err_t fos_charger_read(fos_charger_status_t *out)
{
    if (!out) return ESP_ERR_INVALID_ARG;
    memset(out, 0, sizeof(*out));
    uint8_t reg08 = 0, reg0a = 0;
    esp_err_t err = fos_i2c_read(FOS_I2C_SY6974B, FOS_CHARGER_REG_STATUS, &reg08, 1);
    if (err != ESP_OK) return err;
    err = fos_i2c_read(FOS_I2C_SY6974B, FOS_CHARGER_REG_INPUT, &reg0a, 1);
    if (err != ESP_OK) return err;
    fos_charger_decode(reg08, reg0a, out);
    return ESP_OK;
}

#endif /* ESP_PLATFORM */

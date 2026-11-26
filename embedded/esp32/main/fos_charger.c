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

#include "driver/gpio.h"
#include "esp_rom_sys.h"

#include "fos_board.h"
#include "fos_i2c.h"

void fos_charger_enable(const char *hardware_preset)
{
    int pin = fos_board_charge_enable_pin(hardware_preset);
    if (pin < 0) return;
    /* Low before it is an output: the pin reads high until it is driven, and
     * a moment of driven high is the same "do not charge" it has had since.
     * Held, so the level outlives a deep sleep (a pad of the core's power
     * domain otherwise goes back to its reset state, pull-up included). */
    gpio_hold_dis((gpio_num_t)pin);
    gpio_set_level((gpio_num_t)pin, 0);
    const gpio_config_t cfg = {
        .pin_bit_mask = 1ULL << pin,
        .mode = GPIO_MODE_INPUT_OUTPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_ENABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    if (gpio_config(&cfg) != ESP_OK) return;
    gpio_set_level((gpio_num_t)pin, 0);
    gpio_hold_en((gpio_num_t)pin);
    gpio_deep_sleep_hold_en();
}

void fos_charger_latch_power(const char *hardware_preset)
{
    /* The supplies of the board's peripherals (the CrowPanel watch's), on
     * before anything probes them. */
    for (const fos_board_rail_t *rail = fos_board_rails(hardware_preset); rail && rail->pin >= 0; rail++) {
        gpio_set_direction((gpio_num_t)rail->pin, GPIO_MODE_OUTPUT);
        gpio_set_level((gpio_num_t)rail->pin, rail->level);
    }
    int hold = -1, lock = -1;
    if (!fos_board_power_latch_pins(hardware_preset, &hold, &lock) || hold < 0 || lock < 0) return;
    /* D high, then CP from low to high: the flip-flop's Q goes high and keeps
     * the 3.3 V rail on. Q needs nothing more from either pin, so both go
     * back to inputs: GPIO45 and GPIO46 are strapping pins (VDD_SPI, boot
     * mode), and left driven high a reset could read them. CP falls to low
     * through its 1 MOhm then, which a 74AHC1G79 ignores; only a rising
     * edge with D low would turn the board off. */
    const gpio_config_t cfg = {
        .pin_bit_mask = (1ULL << hold) | (1ULL << lock),
        .mode = GPIO_MODE_OUTPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    gpio_hold_dis((gpio_num_t)hold);
    gpio_hold_dis((gpio_num_t)lock);
    gpio_set_level((gpio_num_t)lock, 0);
    gpio_set_level((gpio_num_t)hold, 1);
    if (gpio_config(&cfg) != ESP_OK) return;
    gpio_set_level((gpio_num_t)lock, 0);
    gpio_set_level((gpio_num_t)hold, 1);
    esp_rom_delay_us(10);
    gpio_set_level((gpio_num_t)lock, 1);
    esp_rom_delay_us(10);
    /* Inputs without pulls (gpio_reset_pin would pull them up). */
    gpio_set_direction((gpio_num_t)hold, GPIO_MODE_INPUT);
    gpio_set_direction((gpio_num_t)lock, GPIO_MODE_INPUT);
}

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

/*
 * The battery fuel gauge: a TI BQ27220 (I2C 0x55) on the Seeed reTerminal
 * Sticky, whose 750 mAh cell has no divider to an ADC pin — the gauge is the
 * only way to read it. It answers what the divider boards work out from a
 * voltage curve (fos_battery.c) and what they cannot know at all: the
 * cell's voltage and state of charge as the gauge's coulomb counter sees
 * them, and whether the cell is being discharged right now — which is the
 * power decision's "on battery" (fos_power.c takes `usb_power`), the same
 * question the E-series' charger answers (fos_charger.c).
 *
 * The Waveshare PhotoPainter has no divider either, but its X-Powers AXP2101
 * PMIC (I2C 0x34, the chip that also switches the panel's EPD_VCC,
 * components/frameos_display/photo_painter_pmic.c) carries a fuel gauge of
 * its own: the same status, read from its registers instead of the TI
 * commands. Whichever of the two answered is "the gauge" to the callers.
 *
 * The decodes are pure (main/tests/test_fos_i2c_devices.c argues with them);
 * the reads go through fos_i2c.c. The BQ27220 is read-only: its
 * configuration is the board maker's, and FrameOS does not touch it. The
 * AXP2101 can boot with its gauge, battery detection and battery-voltage ADC
 * off, so the first read switches the three on (REG18 bit 3, REG68 bit 0,
 * REG30 bit 0) and touches nothing else.
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

/* Standard commands (the BQ27220 technical reference, "Standard Data
 * Commands"): two bytes each, little-endian. */
#define FOS_GAUGE_CMD_VOLTAGE 0x08        /* mV */
#define FOS_GAUGE_CMD_BATTERY_STATUS 0x0A /* flags, below */
#define FOS_GAUGE_CMD_CURRENT 0x0C        /* mA, signed, positive = charging */
#define FOS_GAUGE_CMD_STATE_OF_CHARGE 0x2C /* percent */

/* BatteryStatus() bits. */
#define FOS_GAUGE_STATUS_DSG (1u << 0)      /* discharging */
#define FOS_GAUGE_STATUS_BATTPRES (1u << 3) /* a cell is connected */
#define FOS_GAUGE_STATUS_FC (1u << 9)       /* fully charged */

/* AXP2101 registers (X-Powers datasheet; the same map as XPowersLib). */
#define FOS_AXP2101_REG_STATUS1 0x00       /* bit 5 VBUS good, bit 3 battery present */
#define FOS_AXP2101_REG_STATUS2 0x01       /* [6:5] current direction, [2:0] charge state */
#define FOS_AXP2101_REG_IC_TYPE 0x03       /* 0x4A for an AXP2101 */
#define FOS_AXP2101_REG_GAUGE_CTRL 0x18    /* bit 3 fuel gauge enable */
#define FOS_AXP2101_REG_ADC_CTRL 0x30      /* bit 0 battery voltage measurement enable */
#define FOS_AXP2101_REG_VBAT_H 0x34        /* VBAT [12:8] in bits 4:0, mV */
#define FOS_AXP2101_REG_VBAT_L 0x35        /* VBAT [7:0] */
#define FOS_AXP2101_REG_BATTERY_DET 0x68   /* bit 0 battery detection enable */
#define FOS_AXP2101_REG_BATTERY_PCT 0xA4   /* the gauge's state of charge, percent */
#define FOS_AXP2101_CHIP_ID 0x4A

#define FOS_AXP2101_STATUS1_VBUS_GOOD (1u << 5)
#define FOS_AXP2101_STATUS1_BATTERY (1u << 3)
#define FOS_AXP2101_GAUGE_ENABLE (1u << 3)
#define FOS_AXP2101_ADC_VBAT_ENABLE (1u << 0)
#define FOS_AXP2101_BATTERY_DET_ENABLE (1u << 0)

typedef struct {
    int mv;          /* the cell's voltage; 0 without a reading */
    int pct;         /* state of charge 0..100; -1 without one */
    int current_ma;  /* positive while charging, negative while discharging; 0
                      * from the AXP2101, which does not measure it */
    bool present;    /* a cell is connected */
    bool discharging;
    bool charging;   /* current flowing in: an input is powering the board */
    bool full;
} fos_gauge_status_t;

/* The four words to a status; pure. A voltage of 0 or no cell leaves pct at
 * -1 so a board with the gauge but no cell reads like a board without one. */
void fos_gauge_decode(uint16_t voltage_mv, uint16_t soc, int16_t current_ma, uint16_t status,
                      fos_gauge_status_t *out);
/* The AXP2101's registers to the same status; pure. `vbat_h` / `vbat_l` are
 * REG34 / REG35 as read, `soc` REG A4. "Discharging" is the cell with no
 * input behind it (VBUS not good): what the callers take as "on battery". */
void fos_gauge_decode_axp2101(uint8_t status1, uint8_t status2, uint8_t vbat_h, uint8_t vbat_l,
                              uint8_t soc, fos_gauge_status_t *out);

#ifdef ESP_PLATFORM
#include "esp_err.h"
/* Whether a gauge answered on an I2C bus (fos_i2c_init ran): a BQ27220, or
 * an AXP2101 that gave its chip id. */
bool fos_gauge_present(void);
/* "bq27220", "axp2101", or "none": for the console and the status page. */
const char *fos_gauge_chip_name(void);
/* The AXP2101's registers behind a reading, for the console: REG00 REG01
 * REG18 REG30 REG34 REG35 REG68 REG A4, in that order. */
esp_err_t fos_gauge_axp2101_raw(uint8_t out[8]);
/* Read and decode. ESP_ERR_NOT_FOUND without a gauge. */
esp_err_t fos_gauge_read(fos_gauge_status_t *out);
#endif

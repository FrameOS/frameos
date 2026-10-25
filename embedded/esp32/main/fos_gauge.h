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
 * The decode is pure (main/tests/test_fos_i2c_devices.c argues with it); the
 * reads go through fos_i2c.c. Read-only: the gauge's own configuration is
 * the board maker's, and FrameOS does not touch it.
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

typedef struct {
    int mv;          /* the cell's voltage; 0 without a reading */
    int pct;         /* state of charge 0..100; -1 without one */
    int current_ma;  /* positive while charging, negative while discharging */
    bool present;    /* a cell is connected */
    bool discharging;
    bool charging;   /* current flowing in: an input is powering the board */
    bool full;
} fos_gauge_status_t;

/* The four words to a status; pure. A voltage of 0 or no cell leaves pct at
 * -1 so a board with the gauge but no cell reads like a board without one. */
void fos_gauge_decode(uint16_t voltage_mv, uint16_t soc, int16_t current_ma, uint16_t status,
                      fos_gauge_status_t *out);

#ifdef ESP_PLATFORM
#include "esp_err.h"
/* Whether a gauge answered on an I2C bus (fos_i2c_init ran). */
bool fos_gauge_present(void);
/* Read and decode. ESP_ERR_NOT_FOUND without a gauge. */
esp_err_t fos_gauge_read(fos_gauge_status_t *out);
#endif

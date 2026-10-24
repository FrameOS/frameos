/*
 * The battery charger's view of the power source. The Seeed reTerminal
 * E-series charge their cell through a Silergy SY6974B (I2C 0x6b), whose
 * register map is TI's BQ2560x: REG08 says what is on the input and whether
 * the cell is charging, REG0A whether the input is good. That is the one
 * thing the battery divider cannot tell — a charging cell reads like a cell
 * on its own — so a frame on a desk with USB in no longer counts as "on
 * battery" and deep-sleeps between renders (fos_power.c takes `usb_power`).
 *
 * The decode is pure (main/tests/test_fos_charger.c argues with it); the
 * read goes through fos_i2c.c. Read-only: the chip's own defaults charge the
 * cell, and FrameOS does not touch them.
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

/* REG08 (system status), BQ2560x layout. */
#define FOS_CHARGER_REG_STATUS 0x08
/* REG0A (VBUS good, input limits). */
#define FOS_CHARGER_REG_INPUT 0x0A

typedef struct {
    bool usb_power;   /* an input is present and good: USB (or an adapter) powers the board */
    bool charging;    /* the cell is taking charge (pre-charge or fast charge) */
    bool charge_done; /* charge termination: full */
    uint8_t vbus_stat; /* REG08[7:5] raw: 0 none, 1 USB host, 2 adapter, 7 OTG */
    uint8_t chrg_stat; /* REG08[4:3] raw: 0 idle, 1 pre-charge, 2 fast, 3 done */
} fos_charger_status_t;

/* The two registers to a status; pure. */
void fos_charger_decode(uint8_t reg08, uint8_t reg0a, fos_charger_status_t *out);

#ifdef ESP_PLATFORM
#include "esp_err.h"
/* Whether a charger answered on an I2C bus (fos_i2c_init ran). */
bool fos_charger_present(void);
/* Read and decode. ESP_ERR_NOT_FOUND without a charger. */
esp_err_t fos_charger_read(fos_charger_status_t *out);
#endif

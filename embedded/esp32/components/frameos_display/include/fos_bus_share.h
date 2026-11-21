#pragma once

#include <stdbool.h>
#include <stdint.h>

/* The panel's SPI bus shared with an SD card (the Seeed reTerminal E-series:
 * the TF socket on the panel's SCK/MOSI). The panel takes the bus for the
 * whole of a refresh (DEV_SPI_Acquire), because the vendor drivers drive
 * their chip selects by hand and a card transaction while one of them is low
 * would clock the panel. But most of a refresh is the panel's own: an e-paper
 * waveform behind its BUSY line, 25-30 s on a Spectra, with every chip select
 * high. A card read then (a font's page, a picture) waited for the whole of
 * it: two pages read right after a render that refreshed took 28 s on the
 * E1002 (docs/esp32-fonts.md "On a board").
 *
 * So the panel lets the bus go for each wait it sleeps through
 * (DEV_Delay_ms, which every busy loop, vendor or FrameOS, calls) when it
 * holds the bus and none of its chip selects is low, and takes it back after.
 * Pure: the state is these fields, the decision is fos_bus_share_may_yield,
 * and test_fos_bus_share.c holds it to that. */

typedef struct {
    bool shared;     /* a card is on the panel's bus (DEV_SPI_Bus_Share) */
    bool held;       /* the panel has taken it (DEV_SPI_Acquire) */
    uint32_t cs_low; /* the panel's chip selects driven low, a bit each */
    uint32_t yields; /* waits it let the bus go for */
} fos_bus_share_t;

/* The panel's chip selects, by their slot (EPD_CS_PIN, EPD_CS_M_PIN,
 * EPD_CS_S_PIN: the 13.3" panels have two). */
enum { FOS_BUS_CS_MAIN = 0, FOS_BUS_CS_M = 1, FOS_BUS_CS_S = 2 };

static inline void fos_bus_share_take(fos_bus_share_t *s) { s->held = true; }

static inline void fos_bus_share_give(fos_bus_share_t *s) { s->held = false; }

/* A chip select written: `low` true when driven low (the panel listening). */
static inline void fos_bus_share_select(fos_bus_share_t *s, int line, bool low)
{
    if (line < 0 || line > 31) return;
    if (low) {
        s->cs_low |= 1u << line;
    } else {
        s->cs_low &= ~(1u << line);
    }
}

/* Every chip select high again (the pins configured high at init). */
static inline void fos_bus_share_deselect_all(fos_bus_share_t *s) { s->cs_low = 0; }

/* Whether a wait may let the bus go: shared, held by the panel, and the
 * panel not listening, so a card transaction cannot clock it. */
static inline bool fos_bus_share_may_yield(const fos_bus_share_t *s)
{
    return s->shared && s->held && s->cs_low == 0;
}

// Shared helpers for the streaming panel drivers: command/data sequence
// tables ported from the FrameOS Waveshare reference drivers
// (frameos/src/drivers/waveshare/ePaper), plus busy-polarity helpers.
#ifndef PANEL_SEQ_H
#define PANEL_SEQ_H

#include <stddef.h>
#include <stdint.h>

#include "../pk_display.h"
#include "../pk_platform.h"
#include "../pk_shiftreg.h"
#include "pico/stdlib.h"

// Sequence format: count, command, data...; count = 1 + data bytes.
// count 0 ends the table.
static inline void panel_run_sequence(const pk_pins_t *pins, const uint8_t *seq)
{
    while (*seq) {
        uint8_t count = *seq++;
        pk_epd_command(pins, *seq++);
        for (uint8_t i = 1; i < count; i++) {
            pk_epd_data_byte(pins, *seq++);
        }
    }
}

// The ACeP/Spectra family signals LOW while working. Wait for idle (high).
static inline bool panel_wait_idle(const pk_pins_t *pins, uint32_t timeout_ms)
{
    return pk_epd_wait_idle(pins, timeout_ms);
}

// Power on and refresh, the two steps whose BUSY pulse starts late
// (pk_epd_wait_step). The fallbacks are what the steps take on the glass:
// Pimoroni's driver waits 0.3 s for power on and 32 s for a refresh it got
// no pulse for; a colour refresh measured 25-31 s on the bench.
static inline bool panel_wait_power_on(const pk_pins_t *pins)
{
    return pk_epd_wait_step(pins, "power on", 100, 300, 15000);
}

static inline bool panel_wait_refresh(const pk_pins_t *pins)
{
    return pk_epd_wait_step(pins, "refresh", 100, 32000, 45000);
}

#endif // PANEL_SEQ_H

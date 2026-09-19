// Streaming panel abstraction for the Pico thin client.
//
// A driver never needs a framebuffer: packed rows stream through write()
// into the controller's sequential data RAM, whether they come off the
// network (RP2040, no room to hold a frame), out of the frame buffer (RP2350)
// or from the status screen's row generator. Drivers implement begin (init +
// start-data command), write (raw packed pixels), and end (refresh +
// busy-wait + sleep — or, with refresh=false, just power down: the data RAM
// was written but the glass keeps what it shows).
#ifndef PK_DISPLAY_H
#define PK_DISPLAY_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "pk_config.h"

#include "pk_fosb.h" // PK_PIXEL_* formats

typedef struct pk_panel {
    const char *name;   // FrameOS panel key, e.g. "EPD_5in65f"
    int width;
    int height;
    int format;         // PK_PIXEL_*
    bool (*begin)(const struct pk_panel *panel, const pk_pins_t *pins);
    void (*write)(const uint8_t *data, size_t len);
    bool (*end)(const pk_pins_t *pins, bool refresh);
} pk_panel_t;

const pk_panel_t *pk_display_find(const char *panel_key);
const pk_panel_t *pk_display_panels(size_t *count);
// For pk_config_set(): does this image carry a driver for the panel key?
bool pk_display_panel_known(const char *panel_key);
// The configured panel, or NULL ("none", unset, or no driver).
const pk_panel_t *pk_display_current(void);

// Produces packed row `y` into `row` (pk_fosb_row_bytes() bytes).
typedef void (*pk_display_row_fn)(void *ctx, int y, uint8_t *row);
// Draws a whole frame from a row generator and refreshes the panel.
bool pk_display_show_rows(const pk_panel_t *panel, const pk_pins_t *pins,
                          pk_display_row_fn row_fn, void *ctx);

// Shared SPI helpers for the drivers (initialised on first begin()).
void pk_epd_spi_init(const pk_pins_t *pins);
void pk_epd_spi_baud(uint32_t baud_hz);
void pk_epd_command(const pk_pins_t *pins, uint8_t command);
void pk_epd_data(const pk_pins_t *pins, const uint8_t *data, size_t len);
void pk_epd_data_byte(const pk_pins_t *pins, uint8_t value);
void pk_epd_reset(const pk_pins_t *pins);
bool pk_epd_wait_idle(const pk_pins_t *pins, uint32_t timeout_ms);

#endif // PK_DISPLAY_H

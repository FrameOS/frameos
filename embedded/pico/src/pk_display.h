// Streaming panel abstraction for the Pico thin client.
//
// The device never holds a framebuffer: the FOSB payload from the backend
// streams through pk_display_write() into the controller's sequential data
// RAM. Drivers implement begin (init + start-data command), write (raw
// packed pixels), and end (refresh + busy-wait + sleep).
#ifndef PK_DISPLAY_H
#define PK_DISPLAY_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "pk_config.h"

// FOSB pixel formats — keep in sync with fos_pixel_format_t
// (embedded/esp32/components/frameos_display/include/frameos_display.h).
#define PK_PIXEL_1BPP 1
#define PK_PIXEL_2BPP_GRAY 4
#define PK_PIXEL_4BPP_7COLOR 6
#define PK_PIXEL_4BPP_SPECTRA6 7

typedef struct pk_panel {
    const char *name;   // FrameOS panel key, e.g. "EPD_5in65f"
    int width;
    int height;
    int format;         // PK_PIXEL_*
    bool (*begin)(const struct pk_panel *panel, const pk_pins_t *pins);
    void (*write)(const uint8_t *data, size_t len);
    bool (*end)(const pk_pins_t *pins);
} pk_panel_t;

const pk_panel_t *pk_display_find(const char *panel_key);
const pk_panel_t *pk_display_panels(size_t *count);

// Shared SPI helpers for the drivers (initialised on first begin()).
void pk_epd_spi_init(const pk_pins_t *pins);
void pk_epd_spi_baud(uint32_t baud_hz);
void pk_epd_command(const pk_pins_t *pins, uint8_t command);
void pk_epd_data(const pk_pins_t *pins, const uint8_t *data, size_t len);
void pk_epd_data_byte(const pk_pins_t *pins, uint8_t value);
void pk_epd_reset(const pk_pins_t *pins);
bool pk_epd_wait_idle(const pk_pins_t *pins, uint32_t timeout_ms);

#endif // PK_DISPLAY_H

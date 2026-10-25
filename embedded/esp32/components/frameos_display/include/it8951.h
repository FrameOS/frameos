/*
 * The ITE IT8951 e-paper controller over SPI, driving a 1872x1404 sixteen-
 * grey ED103TC2: the Waveshare 10.3" HAT (panel key EPD_10in3, any ESP32-S3
 * wired to it) and the Seeed reTerminal E1003, which carries the same chip
 * and glass. Same init/clear/display/sleep shape as the Waveshare drivers in
 * the panel table; the Pi drives this controller from
 * frameos/src/drivers/waveshare/it8951/.
 *
 * Unlike every other panel the IT8951 answers: its panel size and image
 * buffer address, the VCOM it holds and whether its waveform engine is still
 * running all come back on MISO. The controller has no D/C line, so the
 * panel's `dc` pin slot carries MISO (FOS_PANEL_BUS_SPI_READ in the panel
 * table), `pwr` switches the panel's power and `cs2` the controller's, where
 * a board has those switches.
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

#define FOS_IT8951_10IN3_WIDTH 1872
#define FOS_IT8951_10IN3_HEIGHT 1404

/* What differs between boards with this controller and glass, chosen by the
 * hardware preset like the 13.3" panel's T133A01 tuning. */
#define FOS_IT8951_VARIANT_WAVESHARE 0
#define FOS_IT8951_VARIANT_SEEED_E1003 1
void fos_it8951_set_variant(int variant);

/* Where the panel temperature comes from on a board whose controller has no
 * sensor of its own (the E1003): true with whole degrees Celsius. */
void fos_it8951_set_temperature_source(bool (*read_celsius)(int *celsius));

/* One row of the packed panel buffer (FOS_PIXEL_4BPP_GRAY: two pixels a
 * byte, the left one in the high nibble, 15 = white) as the controller's
 * 8-bit pixels in the order they go out: left to right, or right to left on
 * a panel whose columns run the other way. `out` holds `width` bytes. Pure
 * (main/tests/test_fos_it8951.c). */
void fos_it8951_row_8bpp(const uint8_t *packed, int width, bool mirror_x, uint8_t *out);

int fos_it8951_10in3_init(void);
void fos_it8951_10in3_clear(void);
void fos_it8951_10in3_display(uint8_t *buf);
void fos_it8951_10in3_sleep(void);

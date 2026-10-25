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
 *
 * The controller keeps the picture in its own memory, and between refreshes
 * it waits in standby, which keeps it: a refresh uploads only the rows that
 * changed since the last one and runs the waveform over the band they span.
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define FOS_IT8951_10IN3_WIDTH 1872
#define FOS_IT8951_10IN3_HEIGHT 1404
/* The bus clock for the controller: FastEPD runs the E1003 at 20 MHz in
 * TRMNL's firmware, reads included, and the TF card on the same pins reads at
 * 20 MHz too. The write-only panels keep the shared 8 MHz. */
#define FOS_IT8951_SPI_HZ (20 * 1000 * 1000)

/* What differs between boards with this controller and glass, chosen by the
 * hardware preset like the 13.3" panel's T133A01 tuning. */
#define FOS_IT8951_VARIANT_WAVESHARE 0
#define FOS_IT8951_VARIANT_SEEED_E1003 1
void fos_it8951_set_variant(int variant);

/* Where the panel temperature comes from on a board whose controller has no
 * sensor of its own (the E1003): true with whole degrees Celsius. */
void fos_it8951_set_temperature_source(bool (*read_celsius)(int *celsius));

/* One row of the packed panel buffer (FOS_PIXEL_4BPP_GRAY: two pixels a
 * byte, the left one in the high nibble, 15 = white) in the order it goes on
 * the wire for a big-endian 4-bit load, whose pixels are the wire's nibbles
 * in order: the bytes as they are, or reversed with their nibbles swapped on
 * a panel whose columns run right to left. `bytes` of each. Pure
 * (main/tests/test_fos_it8951.c). */
void fos_it8951_row_wire(const uint8_t *packed, size_t bytes, bool mirror_x, uint8_t *out);

/* A 64-bit digest of one packed row: what decides whether the row goes to
 * the controller again. Pure. */
uint64_t fos_it8951_row_hash(const uint8_t *row, size_t bytes);

int fos_it8951_10in3_init(void);
void fos_it8951_10in3_clear(void);
void fos_it8951_10in3_display(uint8_t *buf);
void fos_it8951_10in3_sleep(void);

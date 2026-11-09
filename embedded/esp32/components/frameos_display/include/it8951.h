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
/* Reading is another matter: MISO comes through the GPIO matrix, so at 20 MHz
 * the word arrives too late to sample (three boots of a reTerminal E1003 gave
 * three different image buffer addresses). A read is a few words. */
#define FOS_IT8951_SPI_READ_HZ (4 * 1000 * 1000)

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

/* What changed since the last picture, in tiles of the wire's coordinates: 32
 * pixels wide because the controller's display area snaps its X to 32 (the
 * source driver fetches 32-pixel chunks; ESPHome found a 16-aligned update
 * lands up to 16 px left of where it was asked), 8 rows high. Digests of tiles
 * instead of a copy of the picture: 1.25 MiB of PSRAM it does not have to
 * spare on an 8 MB module, and the controller holds the picture anyway.
 * The last column is 16 pixels wide (1872 = 58.5 x 32), the last row 4 rows. */
#define FOS_IT8951_TILE_WIDTH 32
#define FOS_IT8951_TILE_HEIGHT 8
#define FOS_IT8951_TILE_COLS 59
#define FOS_IT8951_TILE_ROWS 176
#define FOS_IT8951_TILES (FOS_IT8951_TILE_COLS * FOS_IT8951_TILE_ROWS)
/* Clean tiles a rectangle carries on through: a separate load and waveform
 * cost more than a few pixels of unchanged picture. */
#define FOS_IT8951_MERGE_GAP_COLS 1
#define FOS_IT8951_MERGE_GAP_ROWS 2
/* The controller runs one waveform at a time, some 0.5 s each, whatever the
 * area: more rectangles are more seconds. */
#define FOS_IT8951_MAX_RECTS 3
/* While someone taps it is one DU over all of them: what is sent is what counts. */
#define FOS_IT8951_MAX_RECTS_INTERACTIVE 16

/* A rectangle of the wire's coordinates. */
typedef struct {
    uint16_t x, y, w, h;
} fos_it8951_rect_t;

/* A digest of every tile of a packed picture (FOS_IT8951_TILES of them in
 * `out`, row by row of tiles). Pure. */
void fos_it8951_tile_hashes(const uint8_t *packed, bool mirror_x, uint32_t *out);

/* The dirty tiles (one byte each) as non-overlapping rectangles, at most
 * `max`, each aligned to the tile grid. Pure. */
size_t fos_it8951_tile_rects(const uint8_t *dirty, fos_it8951_rect_t *rects, size_t max);

/* The dirty tiles exactly, as rectangles that never overlap: a run of the same
 * columns over consecutive rows is one, anything else its own. SIZE_MAX when it
 * takes more than `max`. Pure. */
size_t fos_it8951_tile_spans(const uint8_t *dirty, fos_it8951_rect_t *rects, size_t max);

/* A wire row of greys as pure black and white, a halftone fixed to the panel,
 * for the DU waveform, which draws nothing else: a level of n is n cells of 16
 * white, black and white stay as they are. `x`, `y`: where the row starts on
 * the wire. Pure. */
void fos_it8951_row_halftone(uint8_t *wire, size_t bytes, int x, int y);

/* Every pixel of these wire bytes is pure black or pure white. Pure. */
bool fos_it8951_black_and_white(const uint8_t *wire, size_t bytes);

int fos_it8951_10in3_init(void);
void fos_it8951_10in3_clear(void);
void fos_it8951_10in3_display(uint8_t *buf);
void fos_it8951_10in3_sleep(void);

/* The partial path (PARTIAL_PANELS in generate_panel_table.py). `changed`
 * tells the display layer how much of `buf` differs from what the controller
 * holds, in bytes, and -1 when it does not know what that is; the next
 * show/display uses the same digests. `clean` runs a full waveform over the
 * picture the controller holds. */
void fos_it8951_10in3_partial_init(void);
void fos_it8951_10in3_partial_show(uint8_t *buf, uint8_t *previous);
void fos_it8951_10in3_rest(void);
long fos_it8951_10in3_changed(const uint8_t *buf);
void fos_it8951_10in3_clean(void);
/* Someone is tapping: the next show is one DU over everything that changed,
 * greys as a halftone, and those tiles are owed their greys. `owed` says so;
 * the next show that is not interactive sends them. */
void fos_it8951_10in3_set_interactive(bool interactive);
bool fos_it8951_10in3_owed(void);

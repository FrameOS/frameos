/*
 * Panel-agnostic display API for the FrameOS embedded runtime.
 *
 * Every supported root Waveshare driver is symlinked into the IDF build tree
 * (so it resolves against this component's ESP-IDF DEV_Config) and compiled
 * into one firmware image. The active panel is picked at runtime from the
 * configured panel name — `set panel <key>` on the serial console, the setup
 * portal dropdown, or NVS — with "none" meaning headless.
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "esp_err.h"

typedef enum {
    FOS_PIXEL_1BPP = 1, /* packed 1 bit/pixel, MSB first, white=1 */
    FOS_PIXEL_DUAL_1BPP_RED = 2, /* black plane then red plane, 0=ink */
    FOS_PIXEL_DUAL_1BPP_YELLOW = 3, /* black plane then yellow plane, 0=ink */
    FOS_PIXEL_2BPP_GRAY = 4, /* 4 gray levels, MSB first, 0=black, 3=white */
    FOS_PIXEL_2BPP_BWYR = 5, /* black/white/yellow/red palette indices */
    FOS_PIXEL_4BPP_7COLOR = 6, /* Waveshare 7-color palette indices */
    FOS_PIXEL_4BPP_SPECTRA6 = 7, /* Spectra 6 indices: 0,1,2,3,5,6 */
    FOS_PIXEL_4BPP_GRAY = 8, /* 16 gray levels, MSB first */
    FOS_PIXEL_RGB565 = 9, /* 16-bit colour, 5/6/5, one little-endian word per pixel (an LCD) */
} fos_pixel_format_t;

typedef struct {
    const char *panel;  /* e.g. "EPD_7in5_V2", "none" */
    const char *hardware_preset; /* e.g. "waveshare_esp32_s3_photopainter" */
    int8_t rst, dc, cs, cs2, busy, sck, mosi, pwr;
} fos_display_config_t;

/* Select panel + pins. Does not touch hardware yet. A panel whose controller
 * answers (EPD_10in3, the IT8951) reads `dc` as its MISO pin. */
esp_err_t fos_display_init(const fos_display_config_t *config);
/* Where a panel reads the temperature when its controller picks a waveform
 * by it and has no sensor of its own (the reTerminal E1003's IT8951, from
 * the board's SHT40): true with whole degrees Celsius, false when unknown. */
void fos_display_set_temperature_hook(bool (*read_celsius)(int *celsius));
bool fos_display_present(void);  /* false for panel "none" */
/* The panel actually driving the display ("none" when headless). With the
 * whole panel table compiled in, fos_display_panel_name(0) is just the first
 * table entry — never use it to mean "the selected panel". */
const char *fos_display_selected_panel(void);
int fos_display_width(void);
int fos_display_height(void);
fos_pixel_format_t fos_display_format(void);
/* How the selected panel is wired: one of the FOS_PANEL_BUS_* kinds in the
 * generated frameos_panel_table.h (FOS_PANEL_BUS_SPI, 0, when headless). An
 * RGB LCD owns sixteen data lines and the sync pins: nothing else may blink
 * them. */
int fos_display_bus(void);
/* True when the display refreshes on its own (an LCD scanned from a frame
 * buffer): a blit shows at once and costs no e-paper wait. */
bool fos_display_is_lcd(void);
/* An LCD's own buffer for the next picture, `*len` bytes in the panel's
 * format (fos_display_buffer_size): the renderer draws there in place and
 * fos_display_blit(that buffer) shows it without a copy. The panel stays
 * this task's until then, or until fos_display_release_render_target() hands
 * it back unshown. NULL (and `*len` 0) for every panel that is not an LCD,
 * which renders into a canvas of its own and packs. */
uint8_t *fos_display_render_target(size_t *len, uint32_t *generation);
void fos_display_release_render_target(void);
/* `*generation` above counts the writes into the buffer other than a render
 * drawn in place; report an overlay drawn over such a render here, so the
 * next render into the buffer knows it holds more than the scene drew. */
void fos_display_mark_written(const uint8_t *buf);
/* The same count for any of an LCD's buffers (a render about to draw a
 * buffer whole copies in the newest one that still holds its frame,
 * frameos/utils/svg_frames.nim); -1 for any other pointer or panel. */
int64_t fos_display_buffer_generation(const uint8_t *buf);
/* Called with a panel buffer just before it is written to: a snapshot that
 * points at the last picture shown lets go of it (fos_client.c). */
void fos_display_set_before_write_hook(void (*hook)(const uint8_t *buf));
/* The selected panel's own I2C bus when it runs one on exactly these pins
 * (the SenseCAP Indicator's LCD shares SDA39/SCL40 with its touch
 * controller): the handle (an `i2c_master_bus_handle_t`) for another device
 * to join, or ESP_ERR_NOT_FOUND. */
esp_err_t fos_display_shared_i2c_bus(int sda, int scl, void **bus);
size_t fos_display_buffer_size(void);
size_t fos_display_panel_count(void); /* all panels compiled into this firmware */
/* True for "none" (headless) and for every panel compiled into this
 * firmware: the check the console and the setup page apply before storing a
 * panel key. */
bool fos_display_panel_known(const char *name);
const char *fos_display_panel_name(size_t index);
int fos_display_panel_width(size_t index);
int fos_display_panel_height(size_t index);
fos_pixel_format_t fos_display_panel_format(size_t index);
/* Bytes per pixel of the scene canvas the Nim renderer composites into
 * (frameos/src/embedded/embedded_runtime.nim, `renderCanvas`), decided by
 * the panel first and the module's PSRAM after:
 *
 * - 1 (pixie's 8-bit luma surface) for a greyscale or black-and-white
 *   panel, always. Grey costs it nothing — blending is per channel, so the
 *   luma of a composite is the composite of the lumas, and 256 levels feed
 *   at most 16 — and every pass over the canvas (a fill, a blend, the
 *   dither) moves a quarter of the bytes RGBX would. The 1872x1404
 *   reTerminal E1003 needs it to fit at all (2.5 MB, where 565 was 5.0).
 * - 2 (its 16-bit RGB 5/6/5 surface) for an RGB565 LCD, always: the canvas
 *   is then the panel's own frame buffer (fos_display_render_target), drawn
 *   in place, with nothing to pack or copy.
 * - For a colour e-paper panel, 4 (RGBX) when a full canvas takes at most
 *   half the module's PSRAM, else 2. The 800x480 boards (1.5 MB of 8 MB)
 *   and a 1200x1600 panel on a 16 MB module (7.3 MB) get RGBX; 1200x1600
 *   Spectra 6 on an 8 MB module gets 565, which is what makes it fit at all
 *   (3.7 MB). Rendering into 565 costs colour: the dither keeps its error
 *   rows at full precision, but the 5/6-bit rounding of every stored pixel
 *   turns a smooth gradient into plateaus the diffusion then prints as
 *   visible bands — so 565 canvases store with a per-pixel dither (pixie
 *   `ditherStores`) and RGBX is used wherever it fits.
 *
 * The same rule lives in `embedded_render_canvas_bytes_per_pixel`
 * in backend embedded_firmware.py, `esp32_canvas_bytes_per_pixel` in
 * app/utils/device_limits.py, `esp32CanvasBytesPerPixel` in the SPA's
 * utils/deviceLimits.ts and the wasm preview's devices.ts, and
 * `sceneCanvasFormat` in embedded_runtime.nim; keep them in step
 * (docs/device-limits-fixtures.json pins the TS copy and the Python one). */
#define FOS_RENDER_CANVAS_RGBX_MAX_PSRAM_SHARE 2u
/* The panel formats a luma canvas serves: 1-bit black and white, 2- and
 * 4-bit grey. */
bool fos_pixel_format_is_grey(fos_pixel_format_t format);
size_t fos_render_canvas_bytes_per_pixel(int width, int height, size_t psram_total_bytes,
                                         fos_pixel_format_t format);
/* The above for the selected panel and this module's PSRAM. */
size_t fos_display_canvas_bytes_per_pixel(void);
/* Bytes of the scene canvas for the selected panel (0 when headless). */
size_t fos_display_canvas_bytes(void);
/* PSRAM the on-device renderer needs for this panel: the scene canvas
 * pixie composites into, the selected packed panel output, plus headroom for
 * the Nim heap and QuickJS interpreter. 0 when headless. Used to refuse panels
 * that won't fit the module's PSRAM (they'd OOM mid-render). */
size_t fos_display_render_psram_bytes(void);
/* An SD card on the panel's SPI bus (same SCK/MOSI; the Seeed reTerminal
 * E-series): bring the bus up with the card's MISO and hand back the host the
 * card's sdspi device joins. The panel then holds the bus for each refresh.
 * ESP_ERR_INVALID_STATE when the panel is an I2C one or the bus is already up
 * without that MISO (a restart fixes the second). */
esp_err_t fos_display_spi_bus_share(int miso_pin, int *host);
/* Full update: init panel, push buffer, refresh, put panel to deep sleep.
 * Blocks for the refresh (seconds on e-ink). */
esp_err_t fos_display_blit(const uint8_t *buf, size_t len);
/* Clear to white and sleep the panel. */
esp_err_t fos_display_clear(void);

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
} fos_pixel_format_t;

typedef struct {
    const char *panel;  /* e.g. "EPD_7in5_V2", "none" */
    const char *hardware_preset; /* e.g. "waveshare_esp32_s3_photopainter" */
    int8_t rst, dc, cs, cs2, busy, sck, mosi, pwr;
} fos_display_config_t;

/* Select panel + pins. Does not touch hardware yet. */
esp_err_t fos_display_init(const fos_display_config_t *config);
bool fos_display_present(void);  /* false for panel "none" */
/* The panel actually driving the display ("none" when headless). With the
 * whole panel table compiled in, fos_display_panel_name(0) is just the first
 * table entry — never use it to mean "the selected panel". */
const char *fos_display_selected_panel(void);
int fos_display_width(void);
int fos_display_height(void);
fos_pixel_format_t fos_display_format(void);
size_t fos_display_buffer_size(void);
size_t fos_display_panel_count(void); /* all panels compiled into this firmware */
const char *fos_display_panel_name(size_t index);
int fos_display_panel_width(size_t index);
int fos_display_panel_height(size_t index);
fos_pixel_format_t fos_display_panel_format(size_t index);
/* Bytes per pixel of the scene canvas the Nim renderer composites into
 * (frameos/src/embedded/embedded_runtime.nim, `renderCanvas`), decided per
 * board: 4 (pixie's RGBX) when a full canvas takes at most half the
 * module's PSRAM, else 2 (pixie's 16-bit RGB 5/6/5 surface). Both the
 * 800x480 boards (1.5 MB of 8 MB) and a 1200x1600 panel on a 16 MB module
 * (7.3 MB) get RGBX; 1200x1600 on an 8 MB module gets 565, which is what
 * makes it fit at all (3.7 MB). Rendering into 565 costs colour: the
 * dither keeps its error rows at full precision, but the 5/6-bit rounding
 * of every stored pixel turns a smooth gradient into plateaus the
 * diffusion then prints as visible bands — so 565 canvases store with a
 * per-pixel dither (pixie `ditherStores`) and RGBX is used wherever it
 * fits. The same rule lives in `embedded_render_canvas_bytes_per_pixel` in
 * backend embedded_firmware.py and `sceneCanvasFormat` in
 * embedded_runtime.nim; keep the three in step. */
#define FOS_RENDER_CANVAS_RGBX_MAX_PSRAM_SHARE 2u
size_t fos_render_canvas_bytes_per_pixel(int width, int height, size_t psram_total_bytes);
/* The above for the selected panel and this module's PSRAM. */
size_t fos_display_canvas_bytes_per_pixel(void);
/* Bytes of the scene canvas for the selected panel (0 when headless). */
size_t fos_display_canvas_bytes(void);
/* PSRAM the on-device renderer needs for this panel: the scene canvas
 * pixie composites into, the selected packed panel output, plus headroom for
 * the Nim heap and QuickJS interpreter. 0 when headless. Used to refuse panels
 * that won't fit the module's PSRAM (they'd OOM mid-render). */
size_t fos_display_render_psram_bytes(void);
/* Full update: init panel, push buffer, refresh, put panel to deep sleep.
 * Blocks for the refresh (seconds on e-ink). */
esp_err_t fos_display_blit(const uint8_t *buf, size_t len);
/* Clear to white and sleep the panel. */
esp_err_t fos_display_clear(void);

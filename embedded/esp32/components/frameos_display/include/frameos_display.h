/*
 * Panel-agnostic display API for the FrameOS embedded runtime.
 *
 * One panel is selected at firmware build time. The selected root Waveshare
 * source is symlinked into the IDF build tree so it resolves against this
 * component's ESP-IDF DEV_Config; runtime config may choose that panel or
 * "none", but it cannot switch to a different uncompiled driver.
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
    int8_t rst, dc, cs, cs2, busy, sck, mosi, pwr;
} fos_display_config_t;

/* Select panel + pins. Does not touch hardware yet. */
esp_err_t fos_display_init(const fos_display_config_t *config);
bool fos_display_present(void);  /* false for panel "none" */
int fos_display_width(void);
int fos_display_height(void);
fos_pixel_format_t fos_display_format(void);
size_t fos_display_buffer_size(void);
size_t fos_display_panel_count(void); /* selected compiled panel only */
const char *fos_display_panel_name(size_t index);
int fos_display_panel_width(size_t index);
int fos_display_panel_height(size_t index);
fos_pixel_format_t fos_display_panel_format(size_t index);
/* PSRAM the on-device renderer needs for this panel: the RGBA scene buffer
 * pixie composites into, the selected packed panel output, plus headroom for
 * the Nim heap and QuickJS interpreter. 0 when headless. Used to refuse panels
 * that won't fit the module's PSRAM (they'd OOM mid-render). */
size_t fos_display_render_psram_bytes(void);
/* Full update: init panel, push buffer, refresh, put panel to deep sleep.
 * Blocks for the refresh (seconds on e-ink). */
esp_err_t fos_display_blit(const uint8_t *buf, size_t len);
/* Clear to white and sleep the panel. */
esp_err_t fos_display_clear(void);

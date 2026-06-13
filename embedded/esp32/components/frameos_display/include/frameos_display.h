/*
 * Panel-agnostic display API for the FrameOS embedded runtime.
 *
 * A panel is selected by name at init (from NVS config / generated build
 * config). The vendor Waveshare EPD_*.c drivers are compiled in from
 * frameos/src/drivers/waveshare/ — the same sources the Raspberry Pi build
 * uses — against the ESP-IDF DEV_Config in this component.
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "esp_err.h"

typedef enum {
    FOS_PIXEL_1BPP = 1, /* packed 1 bit/pixel, MSB first, white=1 */
} fos_pixel_format_t;

typedef struct {
    const char *panel;  /* e.g. "EPD_7in5_V2", "none" */
    int8_t rst, dc, cs, busy, sck, mosi, pwr;
} fos_display_config_t;

/* Select panel + pins. Does not touch hardware yet. */
esp_err_t fos_display_init(const fos_display_config_t *config);
bool fos_display_present(void);  /* false for panel "none" */
int fos_display_width(void);
int fos_display_height(void);
fos_pixel_format_t fos_display_format(void);
size_t fos_display_buffer_size(void);
/* Full update: init panel, push buffer, refresh, put panel to deep sleep.
 * Blocks for the refresh (seconds on e-ink). */
esp_err_t fos_display_blit(const uint8_t *buf, size_t len);
/* Clear to white and sleep the panel. */
esp_err_t fos_display_clear(void);

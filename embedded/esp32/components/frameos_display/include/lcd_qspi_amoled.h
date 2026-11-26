/*
 * AMOLED glass behind a QSPI controller that keeps the picture in its own
 * RAM: the CO5300 466x466 round panel of the Waveshare
 * ESP32-S3-Touch-AMOLED-1.75 (and its -B, the same board in a case).
 *
 * Not a Waveshare e-paper panel: a hand-written entry in the runtime panel
 * table (generate_panel_table.py EXTRA_PANELS, bus FOS_PANEL_BUS_QSPI) with
 * the same init/clear/display/sleep shape as the RGB LCDs
 * (lcd_st7701s_rgb.h), and the same API around them, so that the firmware
 * treats it as the LCD it is (fos_display_is_lcd): a scene draws in place in
 * one of two PSRAM frame buffers (FOS_PIXEL_RGB565, little-endian words) and
 * a blit shows it at once.
 *
 * The difference is where the picture lives. An RGB LCD is scanned out of
 * PSRAM continuously; this controller scans its own RAM, and the host writes
 * into it over QSPI only what changed: each present compares the new buffer
 * with the one the glass shows, row by row and then column by column, and
 * sends that rectangle alone (even-aligned, as the controller wants), the
 * words byte-swapped on the way through two small DMA buffers in internal
 * RAM. A clock's second hand is a few kilobytes, a whole frame 434 KB (about
 * 30 ms at 40 MHz). The compare and the push run on a task of their own:
 * the render task hands the picture over and draws the next frame in the
 * other buffer meanwhile, waiting only for the compare to have read it, and
 * at the next present for the push to be over. A flash write cannot tear
 * the picture (nothing scans PSRAM), so a scene store needs no "Updating"
 * screen: those calls are no-ops here.
 *
 * The boot splash and the loading mark (lcd_splash.h, lcd_loading.h) are the
 * RGB LCD's, drawn into the buffer the glass shows and pushed by the
 * rectangle they touched.
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"
#include "lcd_loading.h"
#include "lcd_splash.h"

/* Pick the board's wiring by hardware preset, else by panel key
 * (AMOLED_CO5300_466x466 is the Waveshare 1.75"'s). Called by
 * fos_display_init before the first blit. */
void fos_lcd_qspi_select_board(const char *hardware_preset, const char *panel);
/* The selected board's glass, in pixels (fos_display_init refuses a panel
 * table entry that disagrees). */
void fos_lcd_qspi_size(int *width, int *height);
/* Only the circle inside the square is glass (the Waveshare 1.75"). */
bool fos_lcd_qspi_round(void);

/* The panel table's four: init brings the bus and the controller up once,
 * showing the FrameOS mark on black until the first picture; display shows
 * a packed RGB565 frame (no copy for the buffer fos_lcd_qspi_back_buffer
 * handed out); clear shows white; sleep keeps the picture on. */
int fos_lcd_qspi_init(void);
void fos_lcd_qspi_clear(void);
void fos_lcd_qspi_display(uint8_t *buf);
void fos_lcd_qspi_sleep(void);

/* As fos_lcd_st7701s_back_buffer and its company (lcd_st7701s_rgb.h): the
 * buffer to draw the next picture in, the writer's lock held until display
 * or release; the count of writes into a buffer other than a render in
 * place; the hook a write calls first. */
uint8_t *fos_lcd_qspi_back_buffer(uint32_t *generation);
void fos_lcd_qspi_release_back_buffer(void);
void fos_lcd_qspi_mark_written(const uint8_t *buf);
int64_t fos_lcd_qspi_buffer_generation(const uint8_t *buf);
void fos_lcd_qspi_set_before_write_hook(void (*hook)(const uint8_t *buf));

/* The glass on or off (DISPOFF keeps the controller's RAM; nothing is lit).
 * ESP_ERR_INVALID_STATE before init. */
esp_err_t fos_lcd_qspi_power(bool on);
/* The glass's brightness, 0..255: the controller's 0x51 (the CO5300), or the
 * backlight's PWM (a board with a backlight pin, the GC9309's). Live; kept
 * while the glass is off, and the level it comes back on at. */
esp_err_t fos_lcd_qspi_brightness(uint8_t level);
/* Before a deep sleep: the glass off and the controller in its sleep. */
esp_err_t fos_lcd_qspi_prepare_deep_sleep(void);

void fos_lcd_qspi_splash_status(fos_lcd_splash_status_t status);
void fos_lcd_qspi_set_loading_mark(fos_loading_mark_fn mark);
void fos_lcd_qspi_loading_begin(uint32_t since_tick, int rotation);
void fos_lcd_qspi_loading_end(void);

/* What the pushes cost, for the console's `lcd`. */
typedef struct {
    uint32_t spi_hz;
    uint32_t presents;     /* pictures presented since the last reset */
    uint32_t pushes;       /* of which sent something (the rest changed nothing) */
    uint32_t last_box[4];  /* the last push's rectangle: x, y, w, h */
    uint32_t last_us;      /* how long it took on the bus (the window and the pixels) */
    uint32_t max_us;
    uint64_t push_us;      /* every push's, summed */
    uint64_t compare_us;   /* the compares, summed */
    uint32_t waits;        /* a writer or a present that waited for the job before */
    uint64_t waited_us;    /* and how long, summed */
    uint64_t bytes;        /* pixel bytes sent */
    uint32_t push_stack_free; /* the push task's stack, the least it had free */
    uint8_t brightness;
    bool on;
} fos_lcd_qspi_stats_t;
bool fos_lcd_qspi_stats(fos_lcd_qspi_stats_t *out, bool reset);

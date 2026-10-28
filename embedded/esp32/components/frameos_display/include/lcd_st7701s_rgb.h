/*
 * ST7701S 480x480 IPS LCD on the ESP32-S3's parallel RGB interface — the 4"
 * screen of the Seeed SenseCAP Indicator (D1, D1S, D1L, D1Pro).
 *
 * Not a Waveshare panel: a hand-written entry in the runtime panel table
 * (generate_panel_table.py EXTRA_PANELS) with the same init/clear/display/
 * sleep shape. Frames on this panel are 480x480 in FOS_PIXEL_RGB565, one
 * little-endian 5/6/5 word per pixel, which the LCD peripheral scans out
 * continuously from one of two PSRAM frame buffers through 20-line bounce
 * buffers in internal RAM: a blit is a copy into the hidden buffer (or no
 * copy, for a picture drawn there in place), switched in at the next frame
 * boundary. Why the clock, the core and the heap policy
 * are what they are: embedded/esp32/README.md, "SenseCAP Indicator".
 *
 * The sixteen data lines, the sync pins and the pixel clock are the chip's
 * LCD peripheral's; the controller's own setup goes over a 9-bit 3-wire SPI
 * bit-banged on two GPIOs with chip-select and reset on an I2C IO expander
 * (a TCA9535 at 0x20, an HT8574 at 0x39 on later batches), the way Seeed's
 * own firmware does it. All of that is the board's wiring, so the hardware
 * preset selects the table (fos_lcd_st7701s_select_board); the panel key
 * stays LCD_ST7701S_480x480. The one board known is the SenseCAP Indicator.
 *
 * The expander's I2C bus (SDA39/SCL40 on the Indicator) also carries the
 * FT6336U touch controller: fos_lcd_st7701s_i2c_bus hands the bus to
 * fos_touch.c instead of letting two drivers open the same pins.
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"
#include "lcd_loading.h"
#include "lcd_splash.h"

#define FOS_LCD_ST7701S_WIDTH 480
#define FOS_LCD_ST7701S_HEIGHT 480

/* Pick the board's wiring by hardware preset ("seeed_sensecap_indicator_d1");
 * an unknown or empty preset keeps the Indicator's, the only one there is.
 * Called by fos_display_init before the first blit. */
void fos_lcd_st7701s_select_board(const char *hardware_preset);

/* The panel table's four: init brings the whole stack up once (expander,
 * controller, RGB peripheral, backlight), showing the FrameOS mark on black
 * until the first picture (lcd_splash.h), and is a no-op after; display copies
 * a packed FOS_PIXEL_RGB565 frame into the scan-out buffer; clear shows
 * white; sleep keeps the picture on (an LCD that "slept" after every refresh
 * would be dark). */
int fos_lcd_st7701s_init(void);
void fos_lcd_st7701s_clear(void);
void fos_lcd_st7701s_display(uint8_t *buf);
void fos_lcd_st7701s_sleep(void);

/* The buffer the next picture goes into, to draw it there in place (the Nim
 * renderer's canvas is that buffer: no pack, no copy). Waits for the switch
 * to the last picture to have happened, so nothing reads it any more, and
 * holds the panel's writer lock until fos_lcd_st7701s_display(that buffer)
 * presents it — a copy-free display — or
 * fos_lcd_st7701s_release_back_buffer() gives it back unshown. NULL before
 * init. */
uint8_t *fos_lcd_st7701s_back_buffer(uint32_t *generation);
void fos_lcd_st7701s_release_back_buffer(void);
/* `*generation` above counts the writes into that buffer other than a render
 * drawn in place (a copy, a clear, and what the caller reports here: an
 * overlay drawn over a render in place). */
void fos_lcd_st7701s_mark_written(const uint8_t *buf);
/* That count for any of the panel's buffers, not only the one handed out
 * for drawing: whether a buffer still holds what a render left there when
 * it read the count. -1 for a pointer that is none of them. */
int64_t fos_lcd_st7701s_buffer_generation(const uint8_t *buf);
/* Called with a buffer just before it is written to (drawn in, copied into,
 * cleared): a snapshot that points at the last picture lets go of it. */
void fos_lcd_st7701s_set_before_write_hook(void (*hook)(const uint8_t *buf));

/* The expander's I2C bus when it runs on exactly these pins: `*bus` gets the
 * `i2c_master_bus_handle_t`; ESP_ERR_NOT_FOUND for other pins or before init,
 * ESP_ERR_NOT_SUPPORTED on a chip without an RGB LCD peripheral. */
esp_err_t fos_lcd_st7701s_i2c_bus(int sda, int scl, void **bus);

/* Backlight on or off (the Indicator's GPIO45). ESP_ERR_INVALID_STATE before init. */
esp_err_t fos_lcd_st7701s_backlight(bool on);

/* The loading mark (lcd_loading.h) while a scene switch loads, drawn by a
 * task of its own on core 0 into the buffer being scanned. `mark` is the
 * runtime's (frameos/loading_mark.nim sets it as it starts). Begin on the render task when it starts a
 * switch, with when the switch was asked for and the frame's rotation; the
 * next picture presented puts the mark away, and so does `end` (a switch
 * that came to nothing, a render that failed). Nothing before the first
 * picture: the boot splash owns the panel then. */
void fos_lcd_st7701s_set_loading_mark(fos_loading_mark_fn mark);
void fos_lcd_st7701s_loading_begin(uint32_t since_tick, int rotation);
void fos_lcd_st7701s_loading_end(void);

/* What the boot splash says it is waiting for (lcd_splash.h), from whichever
 * task is booting. It shows once it has lasted FOS_LCD_SPLASH_STATUS_DELAY_MS,
 * and not at all once a picture has replaced the splash. */
void fos_lcd_st7701s_splash_status(fos_lcd_splash_status_t status);

/* How steadily the scan-out runs. The driver refills the DMA's bounce
 * buffers from the PSRAM frame buffer in an interrupt; when the shared
 * flash/PSRAM bus starves that copy the frame comes out late and the picture
 * jumps (CONFIG_LCD_RGB_RESTART_IN_VSYNC resyncs it at the next vertical
 * blank). Every frame's end is timed against the nominal frame period: past
 * a quarter frame it was dropped, past one bounce buffer's lines some of it
 * was scanned from stale lines. The console's `lcd`
 * prints this and sets the pixel clock live, to tune a board on the bench. */
typedef struct {
    uint32_t pclk_hz;
    uint32_t frame_us;         /* nominal frame period at that clock */
    uint32_t frames;           /* frames scanned out since the last reset */
    uint32_t glitches;         /* of which off schedule by more than a quarter frame (dropped) */
    uint32_t late_refills;     /* late past the bounce buffers' slack, not dropped (a band) */
    uint32_t slack_us;         /* that slack at this clock */
    uint32_t max_deviation_us; /* the worst frame's distance from the nominal period */
    int64_t now_us;            /* esp_timer now, to place the glitches below */
    uint8_t recent_count;      /* the last glitches, oldest first */
    struct {
        int64_t at_us;         /* esp_timer time of the late frame's end */
        uint32_t deviation_us;
    } recent[16];
} fos_lcd_st7701s_stats_t;

/* False before init. `reset` zeroes the counters after reading them. */
bool fos_lcd_st7701s_stats(fos_lcd_st7701s_stats_t *out, bool reset);
/* A new pixel clock, applied at the next vertical blank (not stored: the
 * board table's is the default after a restart). */
esp_err_t fos_lcd_st7701s_set_pclk(uint32_t hz);

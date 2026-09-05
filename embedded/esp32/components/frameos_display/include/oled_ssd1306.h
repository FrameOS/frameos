/*
 * SSD1306 72x40 monochrome OLED over I2C — the 0.42" screen on the common
 * ESP32-C3 "HW-675" / 01Space dev boards (SDA GPIO5, SCL GPIO6, address 0x3C).
 *
 * Not a Waveshare panel: a hand-written entry in the runtime panel table
 * (generate_panel_table.py EXTRA_PANELS) with the same init/clear/display/
 * sleep shape. The I2C pins ride on the existing pin config: `sck` is SCL and
 * `mosi` is SDA, so the console `set pins` / hardware preset paths need no
 * new keys. Frames on this panel are 72x40, 1 bpp (white = lit pixel).
 */
#pragma once

#include <stdint.h>

#define FOS_OLED_SSD1306_72X40_WIDTH 72
#define FOS_OLED_SSD1306_72X40_HEIGHT 40

int fos_oled_ssd1306_72x40_init(void);
void fos_oled_ssd1306_72x40_clear(void);
/* buf: FOS_PIXEL_1BPP, row-major, MSB first, 9 bytes per row, 1 = lit. */
void fos_oled_ssd1306_72x40_display(uint8_t *buf);
/* Deliberately keeps the picture on: the blit sequence sleeps every panel
 * after a refresh, which for an OLED would blank it. */
void fos_oled_ssd1306_72x40_sleep(void);

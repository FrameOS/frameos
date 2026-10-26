/*
 * The FrameOS mark on an RGB LCD while the frame boots, in place of a white
 * panel: drawn centered on black when the panel comes up, its three squares
 * then walking the brand colors one square along per third of a cycle, as
 * the Linux boot screen's do (status_screen.nim markSquareColorsAt), until
 * the first picture replaces it. Pure: it draws into a buffer, and
 * lcd_st7701s_rgb.c says which and when; main/tests/test_fos_lcd_splash.c
 * runs it on a laptop.
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

/* One trip of the colors through the three squares, back to the logo. */
#define FOS_LCD_SPLASH_CYCLE_MS 3000u
/* How often the squares are drawn again: 20 frames a second. */
#define FOS_LCD_SPLASH_FRAME_MS 50u

/* The squares' colors `t_ms` into the animation, bottom-left to top-right,
 * as 8-bit RGB: the brand colors at 0 and at every whole cycle. */
void fos_lcd_splash_square_colors(uint32_t t_ms, uint8_t colors[3][3]);

/* Draws the mark centered on `fb`, a `width` x `height` frame of
 * little-endian RGB565 words, over black: the frame and the squares, or
 * with `squares_only` the squares alone (a frame of the animation, every
 * other pixel left as it is). A panel smaller than the mark gets nothing. */
void fos_lcd_splash_draw(uint16_t *fb, int width, int height, uint32_t t_ms, bool squares_only);

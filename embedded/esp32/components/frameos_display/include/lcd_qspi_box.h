/*
 * What a QSPI panel that keeps its own picture (lcd_qspi_amoled.h) is sent
 * when the picture changes: the smallest rectangle around every pixel that
 * differs between the picture on the glass and the new one, widened to the
 * even start and odd end the CO5300 wants, and its pixels as the controller
 * reads them (RGB565, most significant byte first). Pure:
 * main/tests/test_fos_lcd_qspi_box.c runs it on a laptop.
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef struct {
    int x0, y0, x1, y1; /* inclusive */
} fos_lcd_qspi_box_t;

/* The rectangle where `now` differs from `glass`, two `width` x `height`
 * frames of 16-bit pixels (width even). False when they are the same. The
 * rows are found from either end first, so a change near the top and the
 * bottom costs no more than one in the middle, and a frame that changed
 * everywhere costs two row compares. */
bool fos_lcd_qspi_changed_box(const uint16_t *glass, const uint16_t *now, int width, int height,
                              fos_lcd_qspi_box_t *box);

/* Widen `box` to an even x0/y0 and an odd x1/y1, inside the frame (whose
 * width and height are even). */
void fos_lcd_qspi_align_box(fos_lcd_qspi_box_t *box, int width, int height);

/* `rows` rows of the box's pixels from `frame` (stride `width` pixels) into
 * `out`, each word's two bytes swapped. x0 even and the box's width even, so
 * the copy goes a pair of pixels at a time. */
void fos_lcd_qspi_copy_swapped(const uint16_t *frame, int width, const fos_lcd_qspi_box_t *box, int first_row,
                               int rows, uint16_t *out);

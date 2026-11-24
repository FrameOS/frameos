/*
 * A press lit at once on an RGB LCD (docs/realtime-rendering.md "A press
 * shows at once"): the moment a finger lands on an element of the scene's UI
 * (the press map's box, fos_client_press_find), the touch task shades that
 * box in the frame buffer being scanned, before the press is even reported
 * and whatever the render task is doing. The next picture presented takes it
 * away (it is the scene's own answer: its `active:` look, its result), and so
 * does a lift that no picture follows.
 *
 * The pixels under it are saved first and written back to put it away: no
 * pass over the picture, and the buffer is exactly what the render left in
 * it once the shade has gone, as with the loading mark (lcd_loading.h).
 *
 * Pure: no IDF, no locking (the caller holds one lock around every call), so
 * main/tests/test_fos_lcd_press.c runs it on the host.
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* A box bigger than this share of the panel is no button (a whole card list,
 * a scene that takes every press): nothing is lit. */
#define FOS_LCD_PRESS_MAX_SHARE_PERCENT 25

typedef struct {
    /* Set by the owner. */
    int width, height;   /* the panel, in pixels */
    uint16_t *saved;     /* room for the pixels under the shade */
    size_t saved_words;
    /* Its own. */
    int32_t x, y, w, h;  /* where it is, panel pixels */
    uint16_t *drawn_in;  /* the frame buffer holding it, NULL when none */
} fos_lcd_press_t;

/* The box x0, y0, x1, y1 (x1 and y1 past the last pixel), clipped to the
 * panel, shaded in `fb` (RGB565 words, the panel's width a row): darker on a
 * light box, lighter on a dark one, its pixels saved first. One already up is
 * put back first. False, and nothing drawn, for a box that is empty, bigger
 * than FOS_LCD_PRESS_MAX_SHARE_PERCENT of the panel, or more than `saved`
 * holds. */
bool fos_lcd_press_draw(fos_lcd_press_t *p, uint16_t *fb, int32_t x0, int32_t y0, int32_t x1, int32_t y1);

/* Put back where it was drawn; nothing when none is up. */
void fos_lcd_press_put_back(fos_lcd_press_t *p);

/* One pixel shaded as the box is: `darken` for a light box. */
uint16_t fos_lcd_press_shade(uint16_t pixel, bool darken);

/*
 * The loading mark on an RGB LCD (docs/realtime-rendering.md "A switch that
 * takes a while"): while a scene switch loads, a small animated mark over
 * the picture the panel still shows, once the switch has taken longer than
 * FOS_LCD_LOADING_DELAY_MS, gone the moment the next picture is presented.
 *
 * The render task is the one loading the scene, so the mark is drawn by a
 * task of its own on the other core, straight into the frame buffer being
 * scanned (lcd_st7701s_rgb.c says which and when). Before its first frame it
 * saves the pixels under it, and it is put away by writing them back: no
 * pass over the picture, and the buffer is exactly what the render left in
 * it once the mark has gone. What a frame of the mark looks like is the
 * runtime's (frameos/loading_mark.nim, the same on a Pi), reached through
 * `draw`.
 *
 * Pure: no IDF, no clock of its own (the caller passes esp_timer time), and
 * no locking (the caller holds one lock around every call), so
 * main/tests/test_fos_lcd_loading.c runs it on the host.
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* frameos/loading_mark.nim LoadingMarkDelayMs and LoadingMarkFrameMs, and
 * loading_mark_panel.nim LoadingMarkMaxMs (test_esp32_lcd_loading.py keeps
 * them equal): the mark shows once a switch has taken 200 ms, is drawn again
 * 20 times a second, and stops by itself after two minutes, past every
 * render's own deadline. */
#define FOS_LCD_LOADING_DELAY_MS 200
#define FOS_LCD_LOADING_FRAME_MS 50
#define FOS_LCD_LOADING_MAX_MS 120000

/* frameos/loading_mark.nim MarkRect: panel pixels, `w` 0 for none. */
typedef struct {
    int32_t x, y, w, h;
} fos_lcd_loading_rect_t;

/* The runtime's side (frameos/loading_mark.nim, through frameos_nim_glue.c):
 * where a style's mark goes on a panel turned by `rotation`, and one frame
 * of it. `rect` is a fos_lcd_loading_rect_t's four int32s; `style` 0 is no
 * mark, 1 the dots (the default), 2 the spinner, 3 the squares, 4 the bar. */
typedef void (*fos_loading_mark_rect_fn)(int32_t panel_w, int32_t panel_h, int32_t rotation,
                                         int32_t style, int32_t *rect);
typedef void (*fos_loading_mark_draw_fn)(int32_t panel_w, int32_t panel_h, int32_t rotation,
                                         int32_t style, int32_t t_ms, const int32_t *rect,
                                         const void *src, int32_t src_stride, void *dst,
                                         int32_t dst_stride);

/* Frame `t_ms` of the mark: `rect`'s pixels composed from `src` into `dst`
 * (RGB565 words, strides in bytes). */
typedef void (*fos_lcd_loading_draw_t)(int32_t t_ms, const fos_lcd_loading_rect_t *rect,
                                       const uint16_t *src, int32_t src_stride,
                                       uint16_t *dst, int32_t dst_stride);

typedef struct {
    /* Set by the owner. */
    int width, height;          /* the panel, in pixels */
    uint16_t *saved;            /* room for the pixels under the mark */
    size_t saved_words;
    fos_lcd_loading_draw_t draw;
    /* The mark's own. */
    fos_lcd_loading_rect_t rect;
    bool active;                /* a switch is loading */
    int64_t since_us;           /* when it was asked for */
    uint16_t *drawn_in;         /* the frame buffer holding the mark, NULL when none */
    uint32_t frames;            /* drawn for this switch */
    int32_t shown_ms;           /* how long the last switch that showed it took; -1 */
} fos_lcd_loading_t;

/* A switch begins: the mark goes at `rect` (the style's, loading_mark.nim)
 * if it is not up within the delay counted from `since_us`, when the switch
 * was asked for. A switch begun while another still loads keeps the first
 * one's start and its mark. False, and no mark, for an empty rect or one
 * `saved` cannot hold. */
bool fos_lcd_loading_begin(fos_lcd_loading_t *m, const fos_lcd_loading_rect_t *rect, int64_t since_us);

/* One step of the mark's task at `now_us`, with `scanned` the frame buffer
 * on the glass: the frame due now drawn there (the mark first put back in
 * the buffer it was in, when that is no longer the one scanned). Returns the
 * microseconds until the next step, -1 when there is nothing to wait for.
 * `*wrote` is a buffer this step wrote into (the caller counts the write),
 * `*restored` one it put pixels back in; NULL when none. */
int64_t fos_lcd_loading_step(fos_lcd_loading_t *m, uint16_t *scanned, int64_t now_us,
                             uint16_t **wrote, uint16_t **restored);

/* The next picture is being presented, or the switch came to nothing: the
 * mark is put away and the switch is over. Returns the buffer the pixels
 * went back into, NULL when the mark was not up. */
uint16_t *fos_lcd_loading_end(fos_lcd_loading_t *m, int64_t now_us);

/* How long the last switch that showed the mark took, once; -1 otherwise. */
int32_t fos_lcd_loading_take_shown_ms(fos_lcd_loading_t *m);

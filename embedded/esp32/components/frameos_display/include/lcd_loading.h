/*
 * The loading mark on an RGB LCD (docs/realtime-rendering.md "A switch that
 * takes a while"): while a scene switch loads, three pulsing dots in a small
 * dark pill over the picture the panel still shows, once the switch has
 * taken longer than FOS_LCD_LOADING_DELAY_MS, gone the moment the next
 * picture is presented.
 *
 * The render task is the one loading the scene, so the mark is drawn by a
 * task of its own on the other core, straight into the frame buffer being
 * scanned (lcd_st7701s_rgb.c says which and when). Before its first frame it
 * saves the pixels under it, and it is put away by writing them back: no
 * pass over the picture, and the buffer is exactly what the render left in
 * it once the mark has gone. Where it goes and what a frame of it looks like
 * is the runtime's (frameos/loading_mark.nim, the same on a Pi), reached
 * through `draw`.
 *
 * Pure: no IDF, no clock of its own (the caller passes milliseconds of a
 * 32-bit clock, which may wrap: only differences count), and no locking (the
 * caller holds one lock around every call), so
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

/* The runtime's mark (loading_mark.nim, which hands it to the panel's driver
 * as it starts). With `src` NULL: where the mark goes on a panel turned by
 * `rotation`, into `rect` (a fos_lcd_loading_rect_t's four int32s). Else
 * frame `t_ms` of it: `rect`'s pixels composed from `src` into `dst`
 * (RGB565 words, strides in bytes). */
typedef void (*fos_loading_mark_fn)(int32_t panel_w, int32_t panel_h, int32_t rotation, int32_t t_ms,
                                    int32_t *rect, const void *src, int32_t src_stride, void *dst,
                                    int32_t dst_stride);

typedef struct {
    /* Set by the owner. */
    int width, height;          /* the panel, in pixels */
    uint16_t *saved;            /* room for the pixels under the mark */
    size_t saved_words;
    fos_loading_mark_fn draw;
    /* The mark's own. */
    int rotation;               /* the frame's turn onto the panel */
    fos_lcd_loading_rect_t rect;
    bool active;                /* a switch is loading */
    uint32_t since_ms;          /* when it was asked for */
    uint16_t *drawn_in;         /* the frame buffer holding the mark, NULL when none */
} fos_lcd_loading_t;

/* A switch begins, on a frame turned by `rotation`: the mark goes up if the
 * switch has not landed within the delay counted from `since_ms`, when it
 * was asked for. A switch begun while another still loads keeps the first
 * one's start and its mark. False, and no mark, when the runtime gives no
 * rect or one `saved` cannot hold. */
bool fos_lcd_loading_begin(fos_lcd_loading_t *m, int rotation, uint32_t since_ms);

/* One step of the mark's task at `now_ms`, with `scanned` the frame buffer
 * on the glass: the frame due now drawn there (the mark first put back in
 * the buffer it was in, when that is no longer the one scanned). Returns the
 * milliseconds until the next step (at least 1), -1 when there is nothing to
 * wait for. The buffers it wrote are `drawn_in` before and after the step. */
int32_t fos_lcd_loading_step(fos_lcd_loading_t *m, uint16_t *scanned, uint32_t now_ms);

/* The next picture is being presented, or the switch came to nothing: the
 * mark is put away (into `drawn_in`, when it was up) and the switch is over. */
void fos_lcd_loading_end(fos_lcd_loading_t *m);

/*
 * Drawing straight into a packed panel buffer, without Nim or pixie: the
 * 5x7 font and the rectangles behind the boot/portal status screen
 * (fos_status_screen.c) and the LAN access code the render task draws over a
 * render for the panel only (fos_client.c, docs/lan-access.md).
 *
 * A surface is a packed buffer in PANEL orientation (what the packers write
 * and the driver sends) plus the frame's rotation; every coordinate below is
 * in SCENE orientation and lands where the packers would have put that scene
 * pixel (embedded_main.nim panelCoords, fos_http.c's BMP rows), so text
 * reads upright on a rotated frame.
 *
 * Plain C over the buffer: main/tests/test_fos_panel_draw.c checks every
 * pixel format and rotation on a laptop, including that a saved box comes
 * back byte for byte.
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "frameos_display.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    uint8_t *buf;
    int width;  /* panel pixels: the packed buffer's own geometry */
    int height;
    fos_pixel_format_t format;
    int rotate; /* 0 / 90 / 180 / 270 */
} fos_panel_surface_t;

int fos_panel_scene_width(const fos_panel_surface_t *s);
int fos_panel_scene_height(const fos_panel_surface_t *s);

/* The byte a whole buffer is memset to for white. */
uint8_t fos_panel_white_fill(fos_pixel_format_t format);

void fos_panel_fill_rect(const fos_panel_surface_t *s, int x, int y, int w, int h, bool black);
int fos_panel_text_width(const char *text, int scale);
/* The largest scale (at most `scale`) at which `text` fits in `avail` px. */
int fos_panel_fit_scale(const char *text, int scale, int avail);
/* Black 5x7 glyphs, `scale` px per font pixel; unknown characters (and
 * spaces) advance without ink. */
void fos_panel_draw_text(const fos_panel_surface_t *s, const char *text, int x, int y, int scale);

/* The LAN access code's box: centred, white, a black border, a title line
 * (dropped when it cannot fit, on a tiny panel) and the digits as large as
 * the panel allows. */
typedef struct {
    int x, y, w, h;     /* scene coordinates */
    int px, py, pw, ph; /* the same rectangle on the panel */
    int pad;
    int gap;
    int title_scale;    /* 0 = no title */
    int digit_scale;
} fos_panel_code_box_t;

bool fos_panel_code_box(const fos_panel_surface_t *s, const char *title, size_t code_len,
                        fos_panel_code_box_t *box);

/* The packed bytes under the box (whole bytes per row, both planes of a
 * two-plane format), for taking the code out again before anything reads
 * the buffer as an image: copied into `buf` (`restore` false) or from it
 * back onto the panel (`restore` true). Returns how many bytes that is; a
 * NULL `buf` only counts them. */
size_t fos_panel_box_copy(const fos_panel_surface_t *s, const fos_panel_code_box_t *box,
                          uint8_t *buf, bool restore);

void fos_panel_draw_code(const fos_panel_surface_t *s, const fos_panel_code_box_t *box,
                         const char *title, const char *code);

#ifdef __cplusplus
}
#endif

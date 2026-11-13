#include "lcd_splash.h"

#include <stddef.h>
#include <string.h>

#include "lcd_splash_mark.h"
#include "lcd_splash_text.h"

/* frameos_mark.svg's squares, bottom-left to top-right (the same three as
 * status_screen.nim's markSquareColors). */
static const uint8_t k_brand[3][3] = {
    {0x1c, 0x7c, 0x66},
    {0x8b, 0xaa, 0x3a},
    {0xc8, 0xa2, 0x47},
};

void fos_lcd_splash_square_colors(uint32_t t_ms, uint8_t colors[3][3])
{
    uint32_t travel = (t_ms % FOS_LCD_SPLASH_CYCLE_MS) * 3u;
    uint32_t step = travel / FOS_LCD_SPLASH_CYCLE_MS;
    uint32_t blend = travel % FOS_LCD_SPLASH_CYCLE_MS;
    for (int i = 0; i < 3; i++) {
        const uint8_t *from = k_brand[(i + step) % 3];
        const uint8_t *to = k_brand[(i + step + 1) % 3];
        for (int c = 0; c < 3; c++) {
            int value = from[c] + ((int)to[c] - (int)from[c]) * (int)blend / (int)FOS_LCD_SPLASH_CYCLE_MS;
            colors[i][c] = (uint8_t)value;
        }
    }
}

/* `r`, `g`, `b` at coverage `alpha`/31 over black, as an RGB565 word. */
static uint16_t shade(const uint8_t rgb[3], int alpha)
{
    unsigned r = (unsigned)rgb[0] * (unsigned)alpha / 31u;
    unsigned g = (unsigned)rgb[1] * (unsigned)alpha / 31u;
    unsigned b = (unsigned)rgb[2] * (unsigned)alpha / 31u;
    return (uint16_t)(((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3));
}

/* The frame's rotation: the splash is drawn the way up its pictures are. */
static int s_rotation = 0;

void fos_lcd_splash_set_rotation(int degrees)
{
    s_rotation = ((degrees % 360) + 360) % 360;
}

/* The picture's size as the frame shows it: a quarter turn swaps the sides. */
static bool turned(void)
{
    return s_rotation == 90 || s_rotation == 270;
}

/* `count` pixels of `color` from (x, y) along a row of the picture, into the
 * panel's `fb` (`width` x `height`): the packers' mapping (embedded_main.nim
 * panelCoords), a step at a time. */
static void put_run(uint16_t *fb, int width, int height, int x, int y, int count, uint16_t color)
{
    int sw = turned() ? height : width, sh = turned() ? width : height;
    int index = y * width + x, step = 1;
    if (s_rotation == 90) {
        index = x * width + (sh - 1 - y);
        step = width;
    } else if (s_rotation == 180) {
        index = (sh - 1 - y) * width + (sw - 1 - x);
        step = -1;
    } else if (s_rotation == 270) {
        index = (sw - 1 - x) * width + y;
        step = -width;
    }
    for (int k = 0; k < count; k++, index += step) fb[index] = color;
}

void fos_lcd_splash_draw(uint16_t *fb, int width, int height, uint32_t t_ms, bool squares_only)
{
    if (turned()) {
        int swap = width;
        width = height;
        height = swap;
    }
    if (!fb || width < FOS_SPLASH_MARK_W || height < FOS_SPLASH_MARK_H) return;
    static const uint8_t white[3] = {0xff, 0xff, 0xff};
    uint8_t squares[3][3];
    fos_lcd_splash_square_colors(t_ms, squares);
    /* Each layer's color at each of the 32 coverages: [layer][alpha]. */
    uint16_t shades[5][32];
    for (int alpha = 0; alpha < 32; alpha++) {
        shades[0][alpha] = 0;
        shades[1][alpha] = shade(white, alpha);
        for (int i = 0; i < 3; i++) shades[2 + i][alpha] = shade(squares[i], alpha);
    }
    int first_layer = squares_only ? 2 : 1;
    int x0 = (width - FOS_SPLASH_MARK_W) / 2;
    int y0 = (height - FOS_SPLASH_MARK_H) / 2;
    /* In the picture's own sides from here; put_run turns them onto the panel. */
    int pw = turned() ? height : width, ph = turned() ? width : height;
    for (int y = 0; y < FOS_SPLASH_MARK_H; y++) {
        int x = 0;
        for (int i = FOS_SPLASH_MARK_ROWS[y]; i < FOS_SPLASH_MARK_ROWS[y + 1]; i++) {
            uint16_t run = FOS_SPLASH_MARK_RUNS[i];
            int length = run >> 8;
            int layer = (run >> 5) & 7;
            int alpha = run & 31;
            if (layer >= first_layer && x + length <= FOS_SPLASH_MARK_W) {
                put_run(fb, pw, ph, x0 + x, y0 + y, length, shades[layer][alpha]);
            }
            x += length;
        }
    }
}

/* The line's top: this far under the mark. */
#define STATUS_GAP 28

void fos_lcd_splash_draw_status(uint16_t *fb, int width, int height, fos_lcd_splash_status_t status)
{
    int pw = width, ph = height;
    if (turned()) {
        width = ph;
        height = pw;
    }
    int mark_y = (height - FOS_SPLASH_MARK_H) / 2;
    int y0 = mark_y + FOS_SPLASH_MARK_H + STATUS_GAP;
    if (!fb || width < FOS_SPLASH_MARK_W || width < FOS_SPLASH_TEXT_MAX_W || height < FOS_SPLASH_MARK_H ||
        y0 + FOS_SPLASH_TEXT_H > height) {
        return;
    }
    int box_x = (width - FOS_SPLASH_TEXT_MAX_W) / 2;
    for (int y = 0; y < FOS_SPLASH_TEXT_H; y++) put_run(fb, pw, ph, box_x, y0 + y, FOS_SPLASH_TEXT_MAX_W, 0);
    int line = (int)status - 1;
    int line_w = 0; /* the pixels of it drawn: a run past them is left out */
    if (status == FOS_LCD_SPLASH_UPDATING) {
        line = FOS_SPLASH_TEXT_UPDATING_LINE;
        line_w = FOS_SPLASH_TEXT_UPDATING_W;
    } else if (line >= 0 && line < FOS_SPLASH_TEXT_COUNT) {
        line_w = FOS_SPLASH_TEXT_W[line];
    }
    if (line_w <= 0) return;
    static const uint8_t gray[3] = {0x9c, 0xa3, 0xaf};
    uint16_t shades[32];
    for (int alpha = 0; alpha < 32; alpha++) shades[alpha] = shade(gray, alpha);
    int x0 = (width - line_w) / 2;
    for (int y = 0; y < FOS_SPLASH_TEXT_H; y++) {
        int first = FOS_SPLASH_TEXT_ROWS[line * FOS_SPLASH_TEXT_H + y];
        int last = FOS_SPLASH_TEXT_ROWS[line * FOS_SPLASH_TEXT_H + y + 1];
        int x = 0;
        for (int i = first; i < last; i++) {
            uint8_t run = FOS_SPLASH_TEXT_RUNS[i];
            int length = (run >> 5) + 1;
            if ((run & 31) != 0 && x + length <= line_w) put_run(fb, pw, ph, x0 + x, y0 + y, length, shades[run & 31]);
            x += length;
        }
    }
}

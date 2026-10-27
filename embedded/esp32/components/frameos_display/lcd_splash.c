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

void fos_lcd_splash_draw(uint16_t *fb, int width, int height, uint32_t t_ms, bool squares_only)
{
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
    for (int y = 0; y < FOS_SPLASH_MARK_H; y++) {
        uint16_t *row = fb + (size_t)(y0 + y) * (size_t)width + (size_t)x0;
        int x = 0;
        for (int i = FOS_SPLASH_MARK_ROWS[y]; i < FOS_SPLASH_MARK_ROWS[y + 1]; i++) {
            uint16_t run = FOS_SPLASH_MARK_RUNS[i];
            int length = run >> 8;
            int layer = (run >> 5) & 7;
            int alpha = run & 31;
            if (layer >= first_layer && x + length <= FOS_SPLASH_MARK_W) {
                uint16_t color = shades[layer][alpha];
                for (int k = 0; k < length; k++) row[x + k] = color;
            }
            x += length;
        }
    }
}

/* The line's top: this far under the mark. */
#define STATUS_GAP 28

void fos_lcd_splash_draw_status(uint16_t *fb, int width, int height, fos_lcd_splash_status_t status)
{
    int mark_y = (height - FOS_SPLASH_MARK_H) / 2;
    int y0 = mark_y + FOS_SPLASH_MARK_H + STATUS_GAP;
    if (!fb || width < FOS_SPLASH_MARK_W || width < FOS_SPLASH_TEXT_MAX_W || height < FOS_SPLASH_MARK_H ||
        y0 + FOS_SPLASH_TEXT_H > height) {
        return;
    }
    int box_x = (width - FOS_SPLASH_TEXT_MAX_W) / 2;
    for (int y = 0; y < FOS_SPLASH_TEXT_H; y++) {
        memset(fb + (size_t)(y0 + y) * (size_t)width + (size_t)box_x, 0, FOS_SPLASH_TEXT_MAX_W * sizeof(uint16_t));
    }
    int line = (int)status - 1;
    if (line < 0 || line >= FOS_SPLASH_TEXT_COUNT) return;
    static const uint8_t gray[3] = {0x9c, 0xa3, 0xaf};
    uint16_t shades[32];
    for (int alpha = 0; alpha < 32; alpha++) shades[alpha] = shade(gray, alpha);
    int line_w = FOS_SPLASH_TEXT_W[line];
    int x0 = (width - line_w) / 2;
    for (int y = 0; y < FOS_SPLASH_TEXT_H; y++) {
        uint16_t *row = fb + (size_t)(y0 + y) * (size_t)width + (size_t)x0;
        int first = FOS_SPLASH_TEXT_ROWS[line * FOS_SPLASH_TEXT_H + y];
        int last = FOS_SPLASH_TEXT_ROWS[line * FOS_SPLASH_TEXT_H + y + 1];
        int x = 0;
        for (int i = first; i < last; i++) {
            uint8_t run = FOS_SPLASH_TEXT_RUNS[i];
            int length = (run >> 5) + 1;
            if ((run & 31) != 0 && x + length <= line_w) {
                uint16_t color = shades[run & 31];
                for (int k = 0; k < length; k++) row[x + k] = color;
            }
            x += length;
        }
    }
}

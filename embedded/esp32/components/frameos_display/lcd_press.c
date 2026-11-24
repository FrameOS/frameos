#include "lcd_press.h"

#include <string.h>

/* A quarter of the way to black, or to white: each 5- and 6-bit channel at
 * three quarters, no multiply (the masks keep a channel's shifted bits out of
 * its neighbour). */
static uint16_t three_quarters(uint16_t c)
{
    return (uint16_t)(((c >> 1) & 0x7BEFu) + ((c >> 2) & 0x39E7u));
}

uint16_t fos_lcd_press_shade(uint16_t pixel, bool darken)
{
    if (darken) return three_quarters(pixel);
    return (uint16_t)~three_quarters((uint16_t)~pixel);
}

/* Light or dark, by a sparse sample of the box: 0..255 luma, roughly. */
static bool is_light(const uint16_t *fb, int stride, int32_t x, int32_t y, int32_t w, int32_t h)
{
    uint32_t sum = 0, n = 0;
    int32_t step_x = w / 8 > 0 ? w / 8 : 1, step_y = h / 8 > 0 ? h / 8 : 1;
    for (int32_t yy = y + step_y / 2; yy < y + h; yy += step_y) {
        for (int32_t xx = x + step_x / 2; xx < x + w; xx += step_x) {
            uint16_t c = fb[(size_t)yy * (size_t)stride + (size_t)xx];
            uint32_t r = (c >> 11) & 0x1F, g = (c >> 5) & 0x3F, b = c & 0x1F;
            sum += (r * 8 * 77 + g * 4 * 150 + b * 8 * 29) >> 8;
            n++;
        }
    }
    return n == 0 || sum / n >= 96;
}

void fos_lcd_press_put_back(fos_lcd_press_t *p)
{
    if (!p->drawn_in) return;
    uint16_t *row = p->drawn_in + (size_t)p->y * (size_t)p->width + (size_t)p->x;
    const uint16_t *saved = p->saved;
    for (int32_t r = 0; r < p->h; r++) {
        memcpy(row, saved, (size_t)p->w * sizeof(uint16_t));
        row += p->width;
        saved += p->w;
    }
    p->drawn_in = NULL;
}

bool fos_lcd_press_draw(fos_lcd_press_t *p, uint16_t *fb, int32_t x0, int32_t y0, int32_t x1, int32_t y1)
{
    fos_lcd_press_put_back(p);
    if (!fb || !p->saved) return false;
    if (x0 < 0) x0 = 0;
    if (y0 < 0) y0 = 0;
    if (x1 > p->width) x1 = p->width;
    if (y1 > p->height) y1 = p->height;
    int32_t w = x1 - x0, h = y1 - y0;
    if (w <= 0 || h <= 0) return false;
    size_t area = (size_t)w * (size_t)h;
    if (area > p->saved_words ||
        area * 100u > (size_t)p->width * (size_t)p->height * FOS_LCD_PRESS_MAX_SHARE_PERCENT) {
        return false;
    }
    bool darken = is_light(fb, p->width, x0, y0, w, h);
    uint16_t *row = fb + (size_t)y0 * (size_t)p->width + (size_t)x0;
    uint16_t *saved = p->saved;
    for (int32_t r = 0; r < h; r++) {
        memcpy(saved, row, (size_t)w * sizeof(uint16_t));
        for (int32_t c = 0; c < w; c++) row[c] = fos_lcd_press_shade(row[c], darken);
        row += p->width;
        saved += w;
    }
    p->x = x0;
    p->y = y0;
    p->w = w;
    p->h = h;
    p->drawn_in = fb;
    return true;
}

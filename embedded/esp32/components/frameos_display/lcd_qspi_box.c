#include "lcd_qspi_box.h"

#include <string.h>

bool fos_lcd_qspi_changed_box(const uint16_t *glass, const uint16_t *now, int width, int height,
                              fos_lcd_qspi_box_t *box)
{
    size_t row_bytes = (size_t)width * sizeof(uint16_t);
    int y0 = 0;
    while (y0 < height && memcmp(glass + (size_t)y0 * width, now + (size_t)y0 * width, row_bytes) == 0) y0++;
    if (y0 == height) return false;
    int y1 = height - 1;
    while (y1 > y0 && memcmp(glass + (size_t)y1 * width, now + (size_t)y1 * width, row_bytes) == 0) y1--;
    /* The columns, a pair of pixels at a time (a row starts on a word: the
     * width is even): each row only looks where it could widen the box. */
    int pairs = width / 2;
    int p0 = pairs, p1 = -1;
    for (int y = y0; y <= y1; y++) {
        const uint32_t *g = (const uint32_t *)(glass + (size_t)y * width);
        const uint32_t *n = (const uint32_t *)(now + (size_t)y * width);
        int p = 0;
        while (p < p0 && g[p] == n[p]) p++;
        if (p == pairs) continue; /* the same row (between two that differ) */
        if (p < p0) p0 = p;
        int q = pairs - 1;
        while (q > p1 && g[q] == n[q]) q--;
        if (q > p1) p1 = q;
        if (p0 == 0 && p1 == pairs - 1) break; /* as wide as it gets */
    }
    box->x0 = p0 * 2;
    box->x1 = p1 * 2 + 1;
    box->y0 = y0;
    box->y1 = y1;
    return true;
}

void fos_lcd_qspi_align_box(fos_lcd_qspi_box_t *box, int width, int height)
{
    box->x0 &= ~1;
    box->y0 &= ~1;
    box->x1 |= 1;
    box->y1 |= 1;
    if (box->x1 > width - 1) box->x1 = width - 1;
    if (box->y1 > height - 1) box->y1 = height - 1;
}

void fos_lcd_qspi_copy_swapped(const uint16_t *frame, int width, const fos_lcd_qspi_box_t *box, int first_row,
                               int rows, uint16_t *out)
{
    int pairs = (box->x1 - box->x0 + 1) / 2;
    uint32_t *dst = (uint32_t *)out;
    for (int r = 0; r < rows; r++) {
        const uint32_t *src = (const uint32_t *)(frame + (size_t)(first_row + r) * width + box->x0);
        for (int i = 0; i < pairs; i++) {
            uint32_t v = src[i];
            dst[i] = ((v & 0x00FF00FFu) << 8) | ((v >> 8) & 0x00FF00FFu);
        }
        dst += pairs;
    }
}

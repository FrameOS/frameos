/* Host tests for components/frameos_display/lcd_press.c: a press lit at
 * once on an RGB LCD. Built and run by
 * backend/app/tasks/tests/test_esp32_lcd_press.py. */
#include "lcd_press.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int failures = 0;
#define CHECK(cond, what)                                   \
    do {                                                    \
        if (!(cond)) {                                      \
            printf("FAIL %s:%d %s\n", __FILE__, __LINE__, what); \
            failures++;                                     \
        }                                                   \
    } while (0)

#define W 40
#define H 30

static uint16_t fb[W * H];
static uint16_t before[W * H];
static uint16_t saved[W * H];

static void fill(uint16_t color)
{
    for (int i = 0; i < W * H; i++) fb[i] = color;
    /* Some texture: every pixel its own, so a misplaced copy shows. */
    for (int i = 0; i < W * H; i += 7) fb[i] = (uint16_t)(color ^ (uint16_t)i);
    memcpy(before, fb, sizeof(fb));
}

static fos_lcd_press_t fresh(size_t words)
{
    fos_lcd_press_t p;
    memset(&p, 0, sizeof(p));
    p.width = W;
    p.height = H;
    p.saved = saved;
    p.saved_words = words;
    return p;
}

int main(void)
{
    /* The shade's arithmetic: a quarter of the way to black or to white. */
    CHECK(fos_lcd_press_shade(0xFFFF, true) == 0xB5D6, "white darkened: each channel at three quarters (22/31, 46/63)");
    CHECK(fos_lcd_press_shade(0x0000, true) == 0x0000, "black darkened stays black");
    CHECK(fos_lcd_press_shade(0x0000, false) == 0x4A29, "black lightened: a quarter of the way to white");
    CHECK(fos_lcd_press_shade(0xFFFF, false) == 0xFFFF, "white lightened stays white");

    /* A light box darkens, only inside it, and comes back byte for byte. */
    fill(0xFFFF);
    fos_lcd_press_t p = fresh(W * H);
    CHECK(fos_lcd_press_draw(&p, fb, 5, 4, 15, 10), "a small box is lit");
    CHECK(p.drawn_in == fb, "it says where it is");
    CHECK(fb[4 * W + 5] != before[4 * W + 5] || before[4 * W + 5] == 0, "its corner shaded");
    CHECK(fb[6 * W + 8] < before[6 * W + 8], "a light box goes darker");
    CHECK(fb[3 * W + 5] == before[3 * W + 5], "the row above untouched");
    CHECK(fb[4 * W + 15] == before[4 * W + 15], "its right edge is past it");
    CHECK(fb[10 * W + 5] == before[10 * W + 5], "its bottom edge is past it");
    fos_lcd_press_put_back(&p);
    CHECK(p.drawn_in == NULL, "put back: nowhere");
    CHECK(memcmp(fb, before, sizeof(fb)) == 0, "the buffer is what it was, every pixel");
    fos_lcd_press_put_back(&p);
    CHECK(memcmp(fb, before, sizeof(fb)) == 0, "a second put back does nothing");

    /* A dark box lightens. */
    fill(0x0841);
    p = fresh(W * H);
    CHECK(fos_lcd_press_draw(&p, fb, 0, 0, 8, 6), "a dark box is lit");
    CHECK(fb[2 * W + 3] > before[2 * W + 3], "a dark box goes lighter");
    fos_lcd_press_put_back(&p);
    CHECK(memcmp(fb, before, sizeof(fb)) == 0, "and comes back");

    /* Clipped to the panel. */
    fill(0xFFFF);
    p = fresh(W * H);
    CHECK(fos_lcd_press_draw(&p, fb, -5, -5, 6, 6), "a box over the corner is lit where it shows");
    CHECK(p.x == 0 && p.y == 0 && p.w == 6 && p.h == 6, "cut at the panel's edge");
    fos_lcd_press_put_back(&p);
    CHECK(memcmp(fb, before, sizeof(fb)) == 0, "and comes back");

    /* No box: empty, too big a share, more than saved holds. */
    p = fresh(W * H);
    CHECK(!fos_lcd_press_draw(&p, fb, 10, 10, 10, 20), "an empty box is not lit");
    CHECK(!fos_lcd_press_draw(&p, fb, 0, 0, W, H), "the whole panel is no button");
    CHECK(!fos_lcd_press_draw(&p, fb, 0, 0, W / 2 + 1, H / 2 + 1), "past a quarter of the panel is no button");
    p = fresh(20);
    CHECK(!fos_lcd_press_draw(&p, fb, 0, 0, 5, 5), "more than saved holds is not lit");
    CHECK(memcmp(fb, before, sizeof(fb)) == 0, "none of those wrote a pixel");

    /* A second press puts the first back before it is drawn. */
    fill(0xFFFF);
    p = fresh(W * H);
    fos_lcd_press_draw(&p, fb, 2, 2, 8, 8);
    fos_lcd_press_draw(&p, fb, 4, 4, 12, 12);
    fos_lcd_press_put_back(&p);
    CHECK(memcmp(fb, before, sizeof(fb)) == 0, "two presses in a row leave the buffer as it was");

    /* Into another buffer: the first one is restored where it was. */
    static uint16_t other[W * H];
    memcpy(other, before, sizeof(other));
    p = fresh(W * H);
    fos_lcd_press_draw(&p, fb, 2, 2, 8, 8);
    fos_lcd_press_draw(&p, other, 2, 2, 8, 8);
    CHECK(memcmp(fb, before, sizeof(fb)) == 0, "moved to another buffer: the first is clean");
    fos_lcd_press_put_back(&p);
    CHECK(memcmp(other, before, sizeof(other)) == 0, "and the second once put back");

    if (failures) {
        printf("%d failure(s)\n", failures);
        return 1;
    }
    printf("ok: lcd press\n");
    return 0;
}

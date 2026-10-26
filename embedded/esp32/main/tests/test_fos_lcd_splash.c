/*
 * Host tests for the RGB LCD's boot splash (components/frameos_display/
 * lcd_splash.c): the mark's runs fill each row exactly, the mark lands in
 * the middle of the panel over black, its squares sit bottom-left to
 * top-right, and an animation frame redraws the squares and nothing else.
 *
 * Build and run (from embedded/esp32/):
 *
 *   cc -std=c11 -Wall -Wextra -Werror -O2 -Icomponents/frameos_display/include \
 *      components/frameos_display/lcd_splash.c main/tests/test_fos_lcd_splash.c \
 *      -o /tmp/test_fos_lcd_splash && /tmp/test_fos_lcd_splash
 *
 * (backend/app/tasks/tests/test_esp32_lcd_splash.py does exactly that in CI.)
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "lcd_splash.h"
#include "lcd_splash_mark.h"

static int g_failures = 0;
static int g_checks = 0;

#define CHECK(cond, ...)                                                       \
    do {                                                                       \
        g_checks++;                                                            \
        if (!(cond)) {                                                         \
            g_failures++;                                                      \
            printf("FAIL %s:%d: ", __func__, __LINE__);                        \
            printf(__VA_ARGS__);                                               \
            printf("\n");                                                      \
        }                                                                      \
    } while (0)

#define PANEL 480

static uint16_t rgb565(const uint8_t rgb[3])
{
    return (uint16_t)(((rgb[0] >> 3) << 11) | ((rgb[1] >> 2) << 5) | (rgb[2] >> 3));
}

/* The layer at (x, y) of the mark, decoded from the runs on its own. */
static int layer_at(int x, int y, int *alpha)
{
    int at = 0;
    for (int i = FOS_SPLASH_MARK_ROWS[y]; i < FOS_SPLASH_MARK_ROWS[y + 1]; i++) {
        int length = FOS_SPLASH_MARK_RUNS[i] >> 8;
        if (x < at + length) {
            *alpha = FOS_SPLASH_MARK_RUNS[i] & 31;
            return (FOS_SPLASH_MARK_RUNS[i] >> 5) & 7;
        }
        at += length;
    }
    *alpha = 0;
    return -1;
}

static void test_every_row_is_the_marks_width(void)
{
    int bad = 0;
    for (int y = 0; y < FOS_SPLASH_MARK_H; y++) {
        int sum = 0;
        for (int i = FOS_SPLASH_MARK_ROWS[y]; i < FOS_SPLASH_MARK_ROWS[y + 1]; i++) {
            sum += FOS_SPLASH_MARK_RUNS[i] >> 8;
            int layer = (FOS_SPLASH_MARK_RUNS[i] >> 5) & 7;
            if (layer > 4) bad++;
        }
        if (sum != FOS_SPLASH_MARK_W) bad++;
    }
    CHECK(bad == 0, "%d rows or runs out of shape", bad);
    CHECK(FOS_SPLASH_MARK_ROWS[FOS_SPLASH_MARK_H] == FOS_SPLASH_MARK_RUN_COUNT, "the last row ends the runs");
}

static void test_the_mark_is_centered_on_black(void)
{
    static uint16_t fb[PANEL * PANEL];
    memset(fb, 0, sizeof(fb));
    fos_lcd_splash_draw(fb, PANEL, PANEL, 0, false);
    int x0 = (PANEL - FOS_SPLASH_MARK_W) / 2, y0 = (PANEL - FOS_SPLASH_MARK_H) / 2;
    uint8_t brand[3][3];
    fos_lcd_splash_square_colors(0, brand);
    int wrong = 0, outside = 0, solid[5] = {0};
    for (int y = 0; y < PANEL; y++) {
        for (int x = 0; x < PANEL; x++) {
            uint16_t got = fb[y * PANEL + x];
            int mx = x - x0, my = y - y0;
            if (mx < 0 || my < 0 || mx >= FOS_SPLASH_MARK_W || my >= FOS_SPLASH_MARK_H) {
                if (got != 0) outside++;
                continue;
            }
            int alpha = 0;
            int layer = layer_at(mx, my, &alpha);
            if (layer == 0 && got != 0) wrong++;
            if (alpha == 31) {
                solid[layer]++;
                uint16_t want = layer == 1 ? 0xFFFF : rgb565(brand[layer - 2]);
                if (got != want) wrong++;
            }
        }
    }
    CHECK(outside == 0, "%d pixels drawn outside the mark", outside);
    CHECK(wrong == 0, "%d pixels not the layer's color", wrong);
    for (int layer = 1; layer <= 4; layer++) {
        CHECK(solid[layer] > 400, "layer %d has %d solid pixels", layer, solid[layer]);
    }
}

/* Where a square's solid pixels are on average, in mark pixels. */
static void square_center(int layer, int *cx, int *cy)
{
    long sx = 0, sy = 0, n = 0;
    for (int y = 0; y < FOS_SPLASH_MARK_H; y++) {
        for (int x = 0; x < FOS_SPLASH_MARK_W; x++) {
            int alpha = 0;
            if (layer_at(x, y, &alpha) == layer && alpha == 31) {
                sx += x;
                sy += y;
                n++;
            }
        }
    }
    *cx = n ? (int)(sx / n) : -1;
    *cy = n ? (int)(sy / n) : -1;
}

static void test_the_squares_climb_to_the_top_right(void)
{
    int x[3], y[3];
    for (int i = 0; i < 3; i++) square_center(2 + i, &x[i], &y[i]);
    CHECK(x[0] < x[1] && x[1] < x[2], "x %d %d %d", x[0], x[1], x[2]);
    CHECK(y[0] > y[1] && y[1] > y[2], "y %d %d %d", y[0], y[1], y[2]);
}

static void test_the_colors_walk_one_square_a_third(void)
{
    uint8_t at0[3][3], third[3][3], half_step[3][3], cycle[3][3];
    fos_lcd_splash_square_colors(0, at0);
    fos_lcd_splash_square_colors(FOS_LCD_SPLASH_CYCLE_MS / 3, third);
    fos_lcd_splash_square_colors(FOS_LCD_SPLASH_CYCLE_MS / 6, half_step);
    fos_lcd_splash_square_colors(FOS_LCD_SPLASH_CYCLE_MS, cycle);
    CHECK(at0[0][0] == 0x1c && at0[1][0] == 0x8b && at0[2][0] == 0xc8, "the logo's colors at 0");
    CHECK(memcmp(at0, cycle, sizeof(at0)) == 0, "a whole cycle is the logo again");
    /* A third on, each square has its upper neighbor's color. */
    CHECK(memcmp(third[0], at0[1], 3) == 0 && memcmp(third[1], at0[2], 3) == 0 &&
              memcmp(third[2], at0[0], 3) == 0,
          "a third on, the colors moved one square");
    /* Halfway there, halfway between. */
    CHECK(half_step[0][0] == (0x1c + 0x8b) / 2 || half_step[0][0] == (0x1c + 0x8b + 1) / 2,
          "half a step blends: %02x", half_step[0][0]);
}

static void test_a_frame_redraws_the_squares_alone(void)
{
    static uint16_t fb[PANEL * PANEL];
    for (size_t i = 0; i < PANEL * PANEL; i++) fb[i] = 0x1234; /* not anything the splash draws */
    fos_lcd_splash_draw(fb, PANEL, PANEL, FOS_LCD_SPLASH_CYCLE_MS / 3, true);
    int x0 = (PANEL - FOS_SPLASH_MARK_W) / 2, y0 = (PANEL - FOS_SPLASH_MARK_H) / 2;
    uint8_t colors[3][3];
    fos_lcd_splash_square_colors(FOS_LCD_SPLASH_CYCLE_MS / 3, colors);
    int touched_frame = 0, touched_background = 0, squares_wrong = 0, squares = 0;
    for (int my = 0; my < FOS_SPLASH_MARK_H; my++) {
        for (int mx = 0; mx < FOS_SPLASH_MARK_W; mx++) {
            uint16_t got = fb[(y0 + my) * PANEL + x0 + mx];
            int alpha = 0;
            int layer = layer_at(mx, my, &alpha);
            if (layer == 0 && got != 0x1234) touched_background++;
            if (layer == 1 && got != 0x1234) touched_frame++;
            if (layer >= 2 && alpha == 31) {
                squares++;
                if (got != rgb565(colors[layer - 2])) squares_wrong++;
            }
        }
    }
    CHECK(touched_background == 0, "%d background pixels drawn", touched_background);
    CHECK(touched_frame == 0, "%d frame pixels drawn", touched_frame);
    CHECK(squares > 1200 && squares_wrong == 0, "%d of %d square pixels wrong", squares_wrong, squares);
}

static void test_a_panel_smaller_than_the_mark_gets_nothing(void)
{
    uint16_t small[64 * 64];
    memset(small, 0, sizeof(small));
    fos_lcd_splash_draw(small, 64, 64, 0, false);
    int drawn = 0;
    for (size_t i = 0; i < 64 * 64; i++) drawn += small[i] != 0;
    CHECK(drawn == 0, "%d pixels drawn on a 64x64 panel", drawn);
    fos_lcd_splash_draw(NULL, PANEL, PANEL, 0, false); /* no buffer: nothing, no crash */
}

int main(void)
{
    test_every_row_is_the_marks_width();
    test_the_mark_is_centered_on_black();
    test_the_squares_climb_to_the_top_right();
    test_the_colors_walk_one_square_a_third();
    test_a_frame_redraws_the_squares_alone();
    test_a_panel_smaller_than_the_mark_gets_nothing();
    printf("%s: %d checks, %d failures\n", g_failures ? "FAILED" : "ok", g_checks, g_failures);
    return g_failures == 0 ? 0 : 1;
}

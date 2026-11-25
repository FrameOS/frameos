/*
 * Host tests for the RGB LCD driver's board choice
 * (components/frameos_display/lcd_st7701s_rgb.c,
 * fos_lcd_st7701s_select_board): the hardware preset names the board, and
 * without a preset the table knows, the panel key does — a Sunton set up
 * with `set panel LCD_EK9716_800x480` alone booted headless before, because
 * it got the Indicator's 480x480 table and fos_display_init refused the
 * mismatch. Compiled against the driver's ESP32-C3 stub (no RGB
 * peripheral), which also checks that the stub still links.
 *
 * Build and run (from embedded/esp32/):
 *
 *   cc -std=c11 -Wall -Wextra -Werror -O2 -Imain/tests/lcd_board_shim \
 *      -Icomponents/frameos_display/include \
 *      components/frameos_display/lcd_st7701s_rgb.c main/tests/test_fos_lcd_board.c \
 *      -o /tmp/test_fos_lcd_board && /tmp/test_fos_lcd_board
 *
 * (backend/app/tasks/tests/test_esp32_lcd_board.py does exactly that in CI.)
 */
#include <stdio.h>
#include <string.h>

#include "lcd_st7701s_rgb.h"

static int g_failures = 0;
static int g_checks = 0;

static void expect_size(const char *preset, const char *panel, int width, int height, const char *what)
{
    int w = -1, h = -1;
    fos_lcd_st7701s_select_board(preset, panel);
    fos_lcd_st7701s_size(&w, &h);
    g_checks++;
    if (w != width || h != height) {
        g_failures++;
        printf("FAIL: %s: %dx%d, wanted %dx%d\n", what, w, h, width, height);
    }
}

static void expect_board(const char *preset, const char *panel, const char *board, const char *what)
{
    fos_lcd_st7701s_select_board(preset, panel);
    g_checks++;
    if (strcmp(fos_lcd_st7701s_board(), board) != 0) {
        g_failures++;
        printf("FAIL: %s: %s, wanted %s\n", what, fos_lcd_st7701s_board(), board);
    }
}

int main(void)
{
    /* Each preset is its board, whatever panel it names. */
    expect_size("seeed_sensecap_indicator_d1", "LCD_ST7701S_480x480", 480, 480, "indicator");
    expect_size("sunton_esp32_8048s070", "LCD_EK9716_800x480", 800, 480, "sunton");
    expect_size("sunton_esp32_8048s070", NULL, 800, 480, "sunton, no panel");
    /* A preset that contradicts the panel keeps its board: fos_display_init
     * then refuses the mismatch instead of driving the wrong wiring. */
    expect_size("seeed_sensecap_indicator_d1", "LCD_EK9716_800x480", 480, 480, "indicator preset, sunton panel");
    /* No preset, or one that is not an LCD board's: the panel decides. */
    expect_size("", "LCD_EK9716_800x480", 800, 480, "panel alone");
    expect_size(NULL, "LCD_EK9716_800x480", 800, 480, "panel alone, null preset");
    expect_size("waveshare_esp32_s3_photopainter", "LCD_EK9716_800x480", 800, 480, "other preset, sunton panel");
    expect_size("", "LCD_ST7701S_480x480", 480, 480, "indicator panel alone");
    /* Neither: the Indicator's, as before. */
    expect_size(NULL, NULL, 480, 480, "nothing");
    expect_size("", "EPD_7in5_V2", 480, 480, "an e-paper panel");
    /* Two boards share the ST7701S glass: the Guition's preset picks its
     * own wiring, and the panel alone stays the Indicator's. */
    expect_size("guition_esp32_4848s040", "LCD_ST7701S_480x480", 480, 480, "guition");
    expect_board("guition_esp32_4848s040", "LCD_ST7701S_480x480", "guition_esp32_4848s040", "guition board");
    expect_board("guition_esp32_4848s040", NULL, "guition_esp32_4848s040", "guition, no panel");
    expect_board("", "LCD_ST7701S_480x480", "seeed_sensecap_indicator_d1", "st7701s panel alone");
    /* A choice is not sticky: the next call starts over. */
    expect_size("sunton_esp32_8048s070", NULL, 800, 480, "sunton again");
    expect_size(NULL, NULL, 480, 480, "back to nothing");

    if (g_failures) {
        printf("%d of %d checks failed\n", g_failures, g_checks);
        return 1;
    }
    printf("ok: %d checks\n", g_checks);
    return 0;
}

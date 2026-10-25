/*
 * Host tests for the pure half of the IT8951 driver
 * (components/frameos_display/it8951.c): one row of the packed sixteen-grey
 * panel buffer as the 8-bit pixels the controller takes, in wire order —
 * left to right on the Waveshare HAT, right to left on the reTerminal E1003,
 * whose columns run the other way. No IDF: the file keeps it above the
 * ESP_PLATFORM guard.
 *
 * Build and run (from embedded/esp32/):
 *
 *   cc -std=c11 -Wall -Wextra -Werror -O2 -Icomponents/frameos_display/include \
 *      components/frameos_display/it8951.c main/tests/test_fos_it8951.c \
 *      -o /tmp/test_fos_it8951 && /tmp/test_fos_it8951
 *
 * (backend/app/tasks/tests/test_esp32_it8951.py does exactly that in CI.)
 */
#include <stdio.h>
#include <string.h>

#include "it8951.h"

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

static void test_levels_and_order(void)
{
    /* The panel buffer's layout (FOS_PIXEL_4BPP_GRAY, the Nim packer's and
     * the backend's): the left pixel in the high nibble. */
    const uint8_t packed[3] = {0x0F, 0x58, 0xA3};
    uint8_t out[6];
    fos_it8951_row_8bpp(packed, 6, false, out);
    const uint8_t forward[6] = {0x00, 0xFF, 0x55, 0x88, 0xAA, 0x33};
    CHECK(memcmp(out, forward, sizeof(out)) == 0, "left to right: %02x %02x %02x %02x %02x %02x", out[0], out[1],
          out[2], out[3], out[4], out[5]);
    /* Mirrored: the same pixels, last first. */
    fos_it8951_row_8bpp(packed, 6, true, out);
    const uint8_t mirrored[6] = {0x33, 0xAA, 0x88, 0x55, 0xFF, 0x00};
    CHECK(memcmp(out, mirrored, sizeof(out)) == 0, "right to left: %02x %02x %02x %02x %02x %02x", out[0], out[1],
          out[2], out[3], out[4], out[5]);
}

static void test_every_level_keeps_its_top_nibble(void)
{
    /* The controller's GC16 waveform reads the top four bits: level n must
     * come out as n there, black 0x00 and white 0xFF at the ends. */
    for (int level = 0; level < 16; level++) {
        uint8_t packed = (uint8_t)((level << 4) | level);
        uint8_t out[2];
        fos_it8951_row_8bpp(&packed, 2, false, out);
        CHECK(out[0] >> 4 == level && out[1] >> 4 == level, "level %d came out as 0x%02x", level, out[0]);
        CHECK(out[0] == level * 17, "level %d spans the byte: 0x%02x", level, out[0]);
    }
}

static void test_odd_width_and_a_full_row(void)
{
    /* An odd width ends in a high nibble alone. */
    const uint8_t packed[2] = {0x12, 0x30};
    uint8_t out[3];
    fos_it8951_row_8bpp(packed, 3, true, out);
    CHECK(out[0] == 0x33 && out[1] == 0x22 && out[2] == 0x11, "odd width mirrored: %02x %02x %02x", out[0], out[1],
          out[2]);
    /* A full 1872-pixel row: a mirror twice over is the row itself. */
    static uint8_t row[FOS_IT8951_10IN3_WIDTH / 2];
    static uint8_t once[FOS_IT8951_10IN3_WIDTH], twice_packed[FOS_IT8951_10IN3_WIDTH / 2],
        twice[FOS_IT8951_10IN3_WIDTH], forward[FOS_IT8951_10IN3_WIDTH];
    for (size_t i = 0; i < sizeof(row); i++) row[i] = (uint8_t)(i * 37u + 11u);
    fos_it8951_row_8bpp(row, FOS_IT8951_10IN3_WIDTH, true, once);
    for (int x = 0; x < FOS_IT8951_10IN3_WIDTH; x += 2) {
        twice_packed[x / 2] = (uint8_t)((once[x] & 0xF0) | (once[x + 1] >> 4));
    }
    fos_it8951_row_8bpp(twice_packed, FOS_IT8951_10IN3_WIDTH, true, twice);
    fos_it8951_row_8bpp(row, FOS_IT8951_10IN3_WIDTH, false, forward);
    CHECK(memcmp(twice, forward, sizeof(twice)) == 0, "mirrored twice is the row");
    CHECK(once[0] == forward[FOS_IT8951_10IN3_WIDTH - 1], "the first pixel out is the last pixel in");
}

int main(void)
{
    test_levels_and_order();
    test_every_level_keeps_its_top_nibble();
    test_odd_width_and_a_full_row();
    printf("%s: %d checks, %d failures\n", g_failures ? "FAILED" : "ok", g_checks, g_failures);
    return g_failures ? 1 : 0;
}

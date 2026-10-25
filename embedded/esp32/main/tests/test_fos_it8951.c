/*
 * Host tests for the pure half of the IT8951 driver
 * (components/frameos_display/it8951.c): one row of the packed sixteen-grey
 * panel buffer in the order a big-endian 4-bit load takes it — as it is on
 * the Waveshare HAT, reversed nibble by nibble on the reTerminal E1003, whose
 * columns run the other way — and the row digest that decides which rows go
 * to the controller again. No IDF: the file keeps them above the
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

/* The pixel at column x of a wire row: a big-endian 4-bit load reads the
 * wire's nibbles in order, high nibble of each byte first. */
static int wire_pixel(const uint8_t *wire, int x)
{
    return (x & 1) ? (wire[x >> 1] & 0x0F) : (wire[x >> 1] >> 4);
}

static void test_wire_order(void)
{
    /* The panel buffer's layout (FOS_PIXEL_4BPP_GRAY, the Nim packer's and
     * the backend's): the left pixel in the high nibble. Six pixels:
     * 0 F 5 8 A 3. */
    const uint8_t packed[3] = {0x0F, 0x58, 0xA3};
    uint8_t out[3];
    fos_it8951_row_wire(packed, 3, false, out);
    CHECK(memcmp(out, packed, 3) == 0, "left to right is the buffer: %02x %02x %02x", out[0], out[1], out[2]);
    /* Mirrored: the same six pixels, last first — 3 A 8 5 F 0. */
    fos_it8951_row_wire(packed, 3, true, out);
    const uint8_t mirrored[3] = {0x3A, 0x85, 0xF0};
    CHECK(memcmp(out, mirrored, 3) == 0, "right to left: %02x %02x %02x", out[0], out[1], out[2]);
    for (int x = 0; x < 6; x++) {
        CHECK(wire_pixel(out, x) == wire_pixel(packed, 5 - x), "mirrored pixel %d", x);
    }
}

static void test_full_row(void)
{
    /* A whole 1872-pixel row: every pixel lands at its mirror image, and a
     * mirror twice over is the row itself. */
    static uint8_t row[FOS_IT8951_10IN3_WIDTH / 2], once[sizeof(row)], twice[sizeof(row)];
    for (size_t i = 0; i < sizeof(row); i++) row[i] = (uint8_t)(i * 37u + 11u);
    fos_it8951_row_wire(row, sizeof(row), true, once);
    int misplaced = 0;
    for (int x = 0; x < FOS_IT8951_10IN3_WIDTH; x++) {
        if (wire_pixel(once, x) != wire_pixel(row, FOS_IT8951_10IN3_WIDTH - 1 - x)) misplaced++;
    }
    CHECK(misplaced == 0, "%d pixels not at their mirror image", misplaced);
    fos_it8951_row_wire(once, sizeof(once), true, twice);
    CHECK(memcmp(twice, row, sizeof(row)) == 0, "mirrored twice is the row");
}

static void test_row_hash(void)
{
    static uint8_t row[FOS_IT8951_10IN3_WIDTH / 2], other[sizeof(row)];
    for (size_t i = 0; i < sizeof(row); i++) row[i] = (uint8_t)(i * 13u + 7u);
    uint64_t base = fos_it8951_row_hash(row, sizeof(row));
    memcpy(other, row, sizeof(row));
    CHECK(fos_it8951_row_hash(other, sizeof(other)) == base, "the same row, the same digest");
    /* One pixel of one grey step anywhere changes it, in either half of the
     * digest: a changed row must never look unchanged. */
    int same = 0, half_same = 0;
    for (size_t i = 0; i < sizeof(row); i++) {
        for (int nibble = 0; nibble < 2; nibble++) {
            memcpy(other, row, sizeof(row));
            other[i] ^= nibble ? 0x01 : 0x10;
            uint64_t h = fos_it8951_row_hash(other, sizeof(other));
            if (h == base) same++;
            if ((uint32_t)h == (uint32_t)base || (h >> 32) == (base >> 32)) half_same++;
        }
    }
    CHECK(same == 0, "%d one-pixel changes kept the digest", same);
    CHECK(half_same == 0, "%d one-pixel changes kept half the digest", half_same);
    /* Two swapped pixels and two swapped bytes are changes too. */
    memcpy(other, row, sizeof(row));
    other[100] = (uint8_t)((row[100] >> 4) | (row[100] << 4));
    CHECK(row[100] == other[100] || fos_it8951_row_hash(other, sizeof(other)) != base, "swapped pixels");
    memcpy(other, row, sizeof(row));
    other[10] = row[11];
    other[11] = row[10];
    CHECK(fos_it8951_row_hash(other, sizeof(other)) != base, "swapped bytes");
    /* All white and all black differ, and so do lengths. */
    memset(other, 0xFF, sizeof(other));
    uint64_t white = fos_it8951_row_hash(other, sizeof(other));
    memset(other, 0x00, sizeof(other));
    CHECK(fos_it8951_row_hash(other, sizeof(other)) != white, "white is not black");
    CHECK(fos_it8951_row_hash(other, sizeof(other) - 1) != fos_it8951_row_hash(other, sizeof(other)), "length counts");
}

int main(void)
{
    test_wire_order();
    test_full_row();
    test_row_hash();
    printf("%s: %d checks, %d failures\n", g_failures ? "FAILED" : "ok", g_checks, g_failures);
    return g_failures ? 1 : 0;
}

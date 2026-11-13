/*
 * Host tests for the pure half of the IT8951 driver
 * (components/frameos_display/it8951.c): one row of the packed sixteen-grey
 * panel buffer in the order a big-endian 4-bit load takes it — as it is on
 * the Waveshare HAT, reversed nibble by nibble on the reTerminal E1003, whose
 * columns run the other way — and the tile digests and rectangles that decide
 * what goes to the controller again. No IDF: the file keeps them above the
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

static uint8_t g_packed[FOS_IT8951_10IN3_WIDTH / 2 * FOS_IT8951_10IN3_HEIGHT];
static uint32_t g_hashes[FOS_IT8951_TILES], g_after[FOS_IT8951_TILES];

/* The tiles whose digest moved after one pixel of the panel changed. */
static int tiles_moved(int px, int py, bool mirror, int *only)
{
    memset(g_packed, 0xFF, sizeof(g_packed));
    fos_it8951_tile_hashes(g_packed, mirror, g_hashes);
    uint8_t *byte = &g_packed[(size_t)py * (FOS_IT8951_10IN3_WIDTH / 2) + (size_t)px / 2u];
    *byte = (px & 1) ? (uint8_t)(*byte & 0xF0) : (uint8_t)(*byte & 0x0F);
    fos_it8951_tile_hashes(g_packed, mirror, g_after);
    int moved = 0;
    for (int i = 0; i < FOS_IT8951_TILES; i++) {
        if (g_hashes[i] != g_after[i]) {
            moved++;
            *only = i;
        }
    }
    return moved;
}

static void test_tile_hashes(void)
{
    int tile = -1;
    /* Left to right: the first panel pixel is the first tile. */
    CHECK(tiles_moved(0, 0, false, &tile) == 1 && tile == 0, "top left, tile %d", tile);
    /* Mirrored: column 0 of the wire is the panel's right end. */
    CHECK(tiles_moved(FOS_IT8951_10IN3_WIDTH - 1, 0, true, &tile) == 1 && tile == 0, "top right mirrored, tile %d", tile);
    /* ... and the panel's left end is the last column, the half-width one. */
    CHECK(tiles_moved(0, 0, true, &tile) == 1 && tile == FOS_IT8951_TILE_COLS - 1, "top left mirrored, tile %d", tile);
    CHECK(tiles_moved(FOS_IT8951_10IN3_WIDTH - 1, FOS_IT8951_10IN3_HEIGHT - 1, false, &tile) == 1 &&
              tile == FOS_IT8951_TILES - 1,
          "bottom right, tile %d", tile);
    /* The tiles' borders. */
    CHECK(tiles_moved(31, 7, false, &tile) == 1 && tile == 0, "last pixel of the first tile, tile %d", tile);
    CHECK(tiles_moved(32, 8, false, &tile) == 1 && tile == FOS_IT8951_TILE_COLS + 1, "the next one over and down, tile %d", tile);
    /* Every grey step of a pixel shows: both nibbles, the last byte of a tile. */
    memset(g_packed, 0x77, sizeof(g_packed));
    fos_it8951_tile_hashes(g_packed, false, g_hashes);
    int unchanged = 0;
    for (int step = 0; step < 16; step++) {
        if (step == 7) continue;
        g_packed[15] = (uint8_t)(0x70 | step);
        fos_it8951_tile_hashes(g_packed, false, g_after);
        if (g_after[0] == g_hashes[0]) unchanged++;
    }
    g_packed[15] = 0x77;
    CHECK(unchanged == 0, "%d grey steps did not move the digest", unchanged);
}

static uint8_t g_dirty[FOS_IT8951_TILES];

static void mark(int col, int row)
{
    g_dirty[(size_t)row * FOS_IT8951_TILE_COLS + (size_t)col] = 1;
}

static void test_tile_rects(void)
{
    fos_it8951_rect_t rects[FOS_IT8951_MAX_RECTS];
    memset(g_dirty, 0, sizeof(g_dirty));
    CHECK(fos_it8951_tile_rects(g_dirty, rects, FOS_IT8951_MAX_RECTS) == 0, "nothing dirty, no rectangles");

    mark(3, 2);
    size_t count = fos_it8951_tile_rects(g_dirty, rects, FOS_IT8951_MAX_RECTS);
    CHECK(count == 1 && rects[0].x == 96 && rects[0].y == 16 && rects[0].w == 32 && rects[0].h == 8, "one tile: %u %ux%u@%u,%u",
          (unsigned)count, rects[0].w, rects[0].h, rects[0].x, rects[0].y);
    CHECK(rects[0].x % 32 == 0, "the controller's X alignment");

    /* Touching tiles and small gaps are one rectangle. */
    mark(4, 2);
    mark(6, 2); /* one clean column between */
    mark(6, 5); /* two clean rows below */
    count = fos_it8951_tile_rects(g_dirty, rects, FOS_IT8951_MAX_RECTS);
    CHECK(count == 1 && rects[0].x == 96 && rects[0].y == 16 && rects[0].w == 32 * 4 && rects[0].h == 8 * 4, "gaps carried: %u %ux%u@%u,%u",
          (unsigned)count, rects[0].w, rects[0].h, rects[0].x, rects[0].y);

    /* Far apart stays apart. */
    memset(g_dirty, 0, sizeof(g_dirty));
    mark(0, 0);
    mark(50, 100);
    count = fos_it8951_tile_rects(g_dirty, rects, FOS_IT8951_MAX_RECTS);
    CHECK(count == 2, "two rectangles, got %u", (unsigned)count);

    /* The last column is 16 pixels wide, the last row 4 rows high. */
    memset(g_dirty, 0, sizeof(g_dirty));
    mark(FOS_IT8951_TILE_COLS - 1, FOS_IT8951_TILE_ROWS - 1);
    count = fos_it8951_tile_rects(g_dirty, rects, FOS_IT8951_MAX_RECTS);
    CHECK(count == 1 && rects[0].x + rects[0].w == FOS_IT8951_10IN3_WIDTH && rects[0].y + rects[0].h == FOS_IT8951_10IN3_HEIGHT &&
              rects[0].w == 16 && rects[0].h == 4,
          "clipped to the panel: %ux%u@%u,%u", rects[0].w, rects[0].h, rects[0].x, rects[0].y);

    /* A scatter past the limit: every dirty tile still covered, none overlapping. */
    memset(g_dirty, 0, sizeof(g_dirty));
    for (int i = 0; i < 40; i++) mark(i * 3 % FOS_IT8951_TILE_COLS, i * 4 % FOS_IT8951_TILE_ROWS);
    count = fos_it8951_tile_rects(g_dirty, rects, FOS_IT8951_MAX_RECTS);
    CHECK(count >= 1 && count <= FOS_IT8951_MAX_RECTS, "%u rectangles", (unsigned)count);
    int uncovered = 0;
    for (int row = 0; row < FOS_IT8951_TILE_ROWS; row++) {
        for (int col = 0; col < FOS_IT8951_TILE_COLS; col++) {
            if (!g_dirty[(size_t)row * FOS_IT8951_TILE_COLS + (size_t)col]) continue;
            int x = col * FOS_IT8951_TILE_WIDTH, y = row * FOS_IT8951_TILE_HEIGHT;
            bool covered = false;
            for (size_t i = 0; i < count; i++) {
                if (x >= rects[i].x && x < rects[i].x + rects[i].w && y >= rects[i].y && y < rects[i].y + rects[i].h) covered = true;
            }
            if (!covered) uncovered++;
        }
    }
    CHECK(uncovered == 0, "%d dirty tiles outside every rectangle", uncovered);
    int overlaps = 0;
    for (size_t i = 0; i < count; i++) {
        for (size_t j = i + 1; j < count; j++) {
            if (rects[i].x < rects[j].x + rects[j].w && rects[j].x < rects[i].x + rects[i].w && rects[i].y < rects[j].y + rects[j].h &&
                rects[j].y < rects[i].y + rects[i].h) {
                overlaps++;
            }
        }
    }
    CHECK(overlaps == 0, "%d overlapping pairs", overlaps);

    /* All of it dirty is the whole panel. */
    memset(g_dirty, 1, sizeof(g_dirty));
    count = fos_it8951_tile_rects(g_dirty, rects, FOS_IT8951_MAX_RECTS);
    CHECK(count == 1 && rects[0].x == 0 && rects[0].y == 0 && rects[0].w == FOS_IT8951_10IN3_WIDTH && rects[0].h == FOS_IT8951_10IN3_HEIGHT,
          "whole panel: %ux%u@%u,%u", rects[0].w, rects[0].h, rects[0].x, rects[0].y);
}

static void test_tile_spans(void)
{
    fos_it8951_rect_t rects[FOS_IT8951_MAX_RECTS_INTERACTIVE];
    memset(g_dirty, 0, sizeof(g_dirty));
    CHECK(fos_it8951_tile_spans(g_dirty, rects, FOS_IT8951_MAX_RECTS_INTERACTIVE) == 0, "nothing dirty");

    /* A crosshair: a column of tiles and a row of them. */
    int cross_col = 20, cross_row = 90;
    for (int row = 0; row < FOS_IT8951_TILE_ROWS; row++) mark(cross_col, row);
    for (int col = 0; col < FOS_IT8951_TILE_COLS; col++) mark(col, cross_row);
    size_t count = fos_it8951_tile_spans(g_dirty, rects, FOS_IT8951_MAX_RECTS_INTERACTIVE);
    CHECK(count == 3, "above the bar, the bar, below it: %u", (unsigned)count);
    long sent = 0, dirty_px = 0;
    for (size_t i = 0; i < count; i++) sent += (long)rects[i].w * rects[i].h;
    for (int row = 0; row < FOS_IT8951_TILE_ROWS; row++) {
        for (int col = 0; col < FOS_IT8951_TILE_COLS; col++) {
            if (!g_dirty[(size_t)row * FOS_IT8951_TILE_COLS + (size_t)col]) continue;
            int width = col == FOS_IT8951_TILE_COLS - 1 ? 16 : 32;
            int height = row == FOS_IT8951_TILE_ROWS - 1 ? 4 : 8;
            dirty_px += width * height;
        }
    }
    CHECK(sent == dirty_px, "exactly the dirty tiles go on the wire: %ld of %ld", sent, dirty_px);
    int overlaps = 0;
    for (size_t i = 0; i < count; i++) {
        for (size_t j = i + 1; j < count; j++) {
            if (rects[i].x < rects[j].x + rects[j].w && rects[j].x < rects[i].x + rects[i].w && rects[i].y < rects[j].y + rects[j].h &&
                rects[j].y < rects[i].y + rects[i].h) {
                overlaps++;
            }
        }
    }
    CHECK(overlaps == 0, "%d overlapping pairs", overlaps);

    /* A run of the same columns over several rows is one rectangle. */
    memset(g_dirty, 0, sizeof(g_dirty));
    for (int row = 10; row < 14; row++) {
        mark(5, row);
        mark(6, row);
    }
    count = fos_it8951_tile_spans(g_dirty, rects, FOS_IT8951_MAX_RECTS_INTERACTIVE);
    CHECK(count == 1 && rects[0].x == 160 && rects[0].y == 80 && rects[0].w == 64 && rects[0].h == 32, "one block: %u %ux%u@%u,%u",
          (unsigned)count, rects[0].w, rects[0].h, rects[0].x, rects[0].y);

    /* Too many for the limit says so rather than dropping any. */
    memset(g_dirty, 0, sizeof(g_dirty));
    for (int i = 0; i < 20; i++) mark(i * 2, i * 3);
    CHECK(fos_it8951_tile_spans(g_dirty, rects, FOS_IT8951_MAX_RECTS_INTERACTIVE) == SIZE_MAX, "over the limit");
}

static void test_row_halftone(void)
{
    /* Each level over the whole matrix: n cells of 16 white, and pure black
     * and white stay exactly as they are. */
    for (int level = 0; level < 16; level++) {
        int white = 0;
        for (int y = 0; y < 4; y++) {
            for (int x = 0; x < 4; x += 2) {
                uint8_t wire = (uint8_t)(level * 17);
                fos_it8951_row_halftone(&wire, 1, x, y);
                CHECK(fos_it8951_black_and_white(&wire, 1), "level %d is black or white after", level);
                white += (wire >> 4) == 15;
                white += (wire & 15) == 15;
            }
        }
        int want = level == 15 ? 16 : level;
        CHECK(white == want, "level %d: %d of 16 cells white", level, white);
    }
    /* Across the row: the matrix is fixed to the wire, a rectangle that
     * starts somewhere else lands on the same cells. */
    uint8_t whole[8], tail[4];
    memset(whole, 0x88, sizeof(whole));
    memcpy(tail, whole + 4, sizeof(tail));
    fos_it8951_row_halftone(whole, sizeof(whole), 96, 3);
    fos_it8951_row_halftone(tail, sizeof(tail), 96 + 8, 3);
    CHECK(memcmp(tail, whole + 4, sizeof(tail)) == 0, "the halftone does not depend on where a rectangle starts");
}

static void test_black_and_white(void)
{
    const uint8_t plain[] = {0x00, 0xFF, 0x0F, 0xF0};
    CHECK(fos_it8951_black_and_white(plain, sizeof(plain)), "black and white");
    for (int value = 0; value < 256; value++) {
        uint8_t byte = (uint8_t)value;
        int high = value >> 4, low = value & 15;
        bool want = (high == 0 || high == 15) && (low == 0 || low == 15);
        CHECK(fos_it8951_black_and_white(&byte, 1) == want, "byte 0x%02x", value);
    }
}

int main(void)
{
    test_wire_order();
    test_full_row();
    test_tile_hashes();
    test_tile_rects();
    test_tile_spans();
    test_row_halftone();
    test_black_and_white();
    printf("%s: %d checks, %d failures\n", g_failures ? "FAILED" : "ok", g_checks, g_failures);
    return g_failures ? 1 : 0;
}

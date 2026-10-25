/*
 * Host tests for the pure half of the touch panel driver (fos_touch.c): the
 * GT911 report decode, the scaling of a coordinate onto the contract's
 * pointer wire, and the axis-swap rule for a glass mounted the other way
 * round from its controller. No IDF: the file keeps them above the
 * ESP_PLATFORM guard.
 *
 * Build and run (from embedded/esp32/):
 *
 *   cc -std=c11 -Wall -Wextra -Werror -O2 -Imain \
 *      main/fos_touch.c main/tests/test_fos_touch.c \
 *      -o /tmp/test_fos_touch && /tmp/test_fos_touch
 *
 * (backend/app/tasks/tests/test_esp32_touch.py does exactly that in CI.)
 */
#include <stdio.h>
#include <string.h>

#include "fos_touch.h"

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

static void test_decode(void)
{
    fos_touch_point_t points[FOS_TOUCH_POINTS_MAX];
    /* Nothing new: the ready bit is clear, whatever the count says. */
    uint8_t stale[FOS_TOUCH_REPORT_BYTES] = {0x01};
    CHECK(fos_touch_decode(stale, sizeof(stale), points, FOS_TOUCH_POINTS_MAX) == -1, "ready bit clear");
    /* Ready, no finger: the release. */
    uint8_t lifted[FOS_TOUCH_REPORT_BYTES] = {0x80};
    CHECK(fos_touch_decode(lifted, sizeof(lifted), points, FOS_TOUCH_POINTS_MAX) == 0, "no finger");
    /* One finger: track id 0 at (0x1F4, 0x12C) = (500, 300). */
    uint8_t one[FOS_TOUCH_REPORT_BYTES] = {0x81, 0x00, 0xF4, 0x01, 0x2C, 0x01, 0x10, 0x00, 0x00};
    CHECK(fos_touch_decode(one, sizeof(one), points, FOS_TOUCH_POINTS_MAX) == 1, "one finger");
    CHECK(points[0].id == 0 && points[0].x == 500 && points[0].y == 300, "point %u (%u,%u)", points[0].id,
          points[0].x, points[0].y);
    /* Two fingers, the second with track id 3: ids are the controller's,
     * not positions in the list. */
    uint8_t two[FOS_TOUCH_REPORT_BYTES] = {0x82, 0x00, 0x0A, 0x00, 0x14, 0x00, 0x10, 0x00, 0x00,
                                           0x03, 0xE8, 0x03, 0xDC, 0x05, 0x10, 0x00, 0x00};
    CHECK(fos_touch_decode(two, sizeof(two), points, FOS_TOUCH_POINTS_MAX) == 2, "two fingers");
    CHECK(points[1].id == 3 && points[1].x == 1000 && points[1].y == 1500, "second point id %u (%u,%u)",
          points[1].id, points[1].x, points[1].y);
    /* A short buffer cannot hold what the count claims. */
    CHECK(fos_touch_decode(two, 1 + FOS_TOUCH_POINT_BYTES, points, FOS_TOUCH_POINTS_MAX) == -1, "short buffer");
    /* A count past five is garbage, not a report. */
    uint8_t garbage[FOS_TOUCH_REPORT_BYTES] = {0x8F};
    CHECK(fos_touch_decode(garbage, sizeof(garbage), points, FOS_TOUCH_POINTS_MAX) == -1, "count 15 refused");
    /* The caller's room caps the fingers returned, never the parse. */
    CHECK(fos_touch_decode(two, sizeof(two), points, 1) == 1, "capped to the caller's room");
    CHECK(fos_touch_decode(NULL, 0, points, 1) == -1, "NULL report");
}

static void test_decode_ft(void)
{
    fos_touch_point_t points[FOS_TOUCH_POINTS_MAX];
    /* No finger: the count byte alone decides. */
    uint8_t none[FOS_TOUCH_FT_REPORT_BYTES] = {0x00};
    CHECK(fos_touch_decode_ft(none, sizeof(none), points, FOS_TOUCH_POINTS_MAX) == 0, "no finger");
    /* One finger in contact (event 2), track id 0 at (0x1F4, 0x12C) = (500, 300). */
    uint8_t one[FOS_TOUCH_FT_REPORT_BYTES] = {0x01, 0x81, 0xF4, 0x01, 0x2C, 0x10, 0x05};
    CHECK(fos_touch_decode_ft(one, sizeof(one), points, FOS_TOUCH_POINTS_MAX) == 1, "one finger");
    CHECK(points[0].id == 0 && points[0].x == 500 && points[0].y == 300, "point %u (%u,%u)", points[0].id,
          points[0].x, points[0].y);
    /* A press-down event (0) counts; a lift (1) does not; the second finger's
     * id is the controller's. */
    uint8_t two[FOS_TOUCH_FT_REPORT_BYTES] = {0x02, 0x00, 0x0A, 0x00, 0x14, 0x10, 0x05,
                                              0x41, 0x90, 0x11, 0xDF, 0x10, 0x05};
    CHECK(fos_touch_decode_ft(two, sizeof(two), points, FOS_TOUCH_POINTS_MAX) == 1, "a lifted finger is not down");
    CHECK(points[0].id == 0 && points[0].x == 10 && points[0].y == 20, "first point (%u,%u)", points[0].x,
          points[0].y);
    two[7] = 0x81; /* the second finger in contact */
    CHECK(fos_touch_decode_ft(two, sizeof(two), points, FOS_TOUCH_POINTS_MAX) == 2, "two fingers");
    CHECK(points[1].id == 1 && points[1].x == 400 && points[1].y == 479, "second point id %u (%u,%u)",
          points[1].id, points[1].x, points[1].y);
    /* The caller's room caps the fingers; a short buffer and a wild count are refused. */
    CHECK(fos_touch_decode_ft(two, sizeof(two), points, 1) == 1, "capped to the caller's room");
    CHECK(fos_touch_decode_ft(two, 1 + FOS_TOUCH_FT_POINT_BYTES, points, FOS_TOUCH_POINTS_MAX) == -1, "short buffer");
    uint8_t garbage[FOS_TOUCH_FT_REPORT_BYTES] = {0x0F};
    CHECK(fos_touch_decode_ft(garbage, sizeof(garbage), points, FOS_TOUCH_POINTS_MAX) == -1, "count 15 refused");
    CHECK(fos_touch_decode_ft(NULL, 0, points, 1) == -1, "NULL report");
}

static void test_wire(void)
{
    /* The panel's two ends land on the wire's two ends, whatever the range. */
    CHECK(fos_touch_wire(0, 800) == 0, "left edge");
    CHECK(fos_touch_wire(799, 800) == FOS_TOUCH_WIRE_MAX, "right edge");
    CHECK(fos_touch_wire(0, 480) == 0 && fos_touch_wire(479, 480) == FOS_TOUCH_WIRE_MAX, "480 range");
    /* Halfway is halfway, to the wire's resolution. */
    int mid = fos_touch_wire(400, 801);
    CHECK(mid > FOS_TOUCH_WIRE_MAX / 2 - 2 && mid < FOS_TOUCH_WIRE_MAX / 2 + 2, "middle %d", mid);
    /* Out of range is clamped, never wrapped or negative. */
    CHECK(fos_touch_wire(-5, 800) == 0, "negative clamps");
    CHECK(fos_touch_wire(5000, 800) == FOS_TOUCH_WIRE_MAX, "overshoot clamps");
    CHECK(fos_touch_wire(10, 0) == 0 && fos_touch_wire(10, 1) == 0, "no range");
}

static void test_axes(void)
{
    /* The Sticky's glass scanned as 480x800 under an 800x480 panel: swapped. */
    CHECK(fos_touch_axes_swapped(480, 800, 800, 480), "portrait controller, landscape panel");
    CHECK(!fos_touch_axes_swapped(800, 480, 800, 480), "same way round");
    CHECK(fos_touch_axes_swapped(800, 480, 480, 800), "landscape controller, portrait panel");
    /* A square, or no size: nothing to decide. */
    CHECK(!fos_touch_axes_swapped(600, 600, 800, 480), "square controller");
    CHECK(!fos_touch_axes_swapped(0, 0, 800, 480), "no controller range");
    CHECK(!fos_touch_axes_swapped(480, 800, 0, 0), "no panel");
}

int main(void)
{
    test_decode();
    test_decode_ft();
    test_wire();
    test_axes();
    printf("%s: %d checks, %d failures\n", g_failures ? "FAILED" : "ok", g_checks, g_failures);
    return g_failures == 0 ? 0 : 1;
}

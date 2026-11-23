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
#include "fos_events_gen.h"

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

static void test_move_slot(void)
{
    fos_touch_event_t q[4];
    memset(q, 0, sizeof(q));
    CHECK(fos_touch_move_slot(q, 4, 0, 0, 0) == -1, "an empty queue merges nothing");

    /* Two fingers moving: each new move finds its own, past the other's. */
    q[0] = (fos_touch_event_t){.kind = FOS_TOUCH_MOVE, .id = 0};
    q[1] = (fos_touch_event_t){.kind = FOS_TOUCH_MOVE, .id = 1};
    CHECK(fos_touch_move_slot(q, 4, 0, 2, 0) == 0, "finger 0 past finger 1");
    CHECK(fos_touch_move_slot(q, 4, 0, 2, 1) == 1, "finger 1 at the tail");
    CHECK(fos_touch_move_slot(q, 4, 0, 2, 2) == -1, "a finger with nothing queued");

    /* A press or a release stays ahead of what follows it. */
    q[2] = (fos_touch_event_t){.kind = FOS_TOUCH_UP, .id = 0};
    CHECK(fos_touch_move_slot(q, 4, 0, 3, 0) == -1, "never past a release");
    q[2] = (fos_touch_event_t){.kind = FOS_TOUCH_DOWN, .id = 0};
    CHECK(fos_touch_move_slot(q, 4, 0, 3, 0) == -1, "never past a press");
    CHECK(fos_touch_move_slot(q, 4, 0, 3, 1) == 1, "the other finger is not held back");

    /* Around the end of the ring: slots 3, 0, 1, oldest first. */
    q[3] = (fos_touch_event_t){.kind = FOS_TOUCH_MOVE, .id = 0};
    q[0] = (fos_touch_event_t){.kind = FOS_TOUCH_MOVE, .id = 1};
    q[1] = (fos_touch_event_t){.kind = FOS_TOUCH_MOVE, .id = 1};
    CHECK(fos_touch_move_slot(q, 4, 3, 3, 0) == 3, "wraps to the oldest slot");
    CHECK(fos_touch_move_slot(q, 4, 3, 3, 1) == 1, "the newest of the same finger");
}

static void test_touch_beep(void)
{
    uint8_t held = 0, beeped = 0;
    CHECK(fos_touch_beep_step(FOS_TOUCH_DOWN, 0, true, &held, &beeped) == FOS_TOUCH_BEEP_DOWN, "a taken press clicks");
    CHECK(fos_touch_beep_step(FOS_TOUCH_MOVE, 0, false, &held, &beeped) == FOS_TOUCH_BEEP_NONE, "a move is silent");
    CHECK(fos_touch_beep_step(FOS_TOUCH_DOWN, 1, true, &held, &beeped) == FOS_TOUCH_BEEP_SECOND_DOWN,
          "a second finger sounds different");
    CHECK(fos_touch_beep_step(FOS_TOUCH_UP, 1, false, &held, &beeped) == FOS_TOUCH_BEEP_UP, "its release clicks");
    CHECK(fos_touch_beep_step(FOS_TOUCH_UP, 0, false, &held, &beeped) == FOS_TOUCH_BEEP_UP, "the first's too");
    CHECK(held == 0 && beeped == 0, "nothing left held");

    CHECK(fos_touch_beep_step(FOS_TOUCH_DOWN, 0, false, &held, &beeped) == FOS_TOUCH_BEEP_NONE,
          "a press on nothing is silent");
    CHECK(fos_touch_beep_step(FOS_TOUCH_UP, 0, false, &held, &beeped) == FOS_TOUCH_BEEP_NONE, "and so is its release");

    fos_touch_beep_step(FOS_TOUCH_DOWN, 0, false, &held, &beeped);
    CHECK(fos_touch_beep_step(FOS_TOUCH_DOWN, 1, true, &held, &beeped) == FOS_TOUCH_BEEP_SECOND_DOWN,
          "a taken second finger, the first on nothing");
    CHECK(fos_touch_beep_step(FOS_TOUCH_UP, 0, false, &held, &beeped) == FOS_TOUCH_BEEP_NONE, "the silent one stays silent");
    fos_touch_beep_step(FOS_TOUCH_UP, 1, false, &held, &beeped);
    CHECK(fos_touch_beep_step(FOS_TOUCH_DOWN, 0, true, &held, &beeped) == FOS_TOUCH_BEEP_DOWN, "alone again, the plain click");
}

static void test_glided(void)
{
    /* The SenseCAP Indicator's traces (480 px glass, 2026-11-14): two thumbs
     * the FT6336U took for one, gliding 64-74 px sideways in the 20 ms
     * settle, against one thumb rolling up or a little sideways. */
    CHECK(fos_touch_glided(-74, -5, 480), "189,380 -> 115,375: a second thumb");
    CHECK(fos_touch_glided(64, -1, 480), "352,415 -> 416,414: a second thumb");
    CHECK(!fos_touch_glided(0, -13, 480), "284,436 -> 284,423: a roll up");
    CHECK(!fos_touch_glided(-8, -89, 480), "287,470 -> 279,381: a long roll up");
    CHECK(!fos_touch_glided(15, 0, 480), "387 -> 402: under a tenth of the glass");
    CHECK(!fos_touch_glided(50, -30, 480), "as much up as sideways: not a glide");
    CHECK(fos_touch_glided(48, 0, 480), "a tenth of the glass exactly");
    CHECK(!fos_touch_glided(48, 0, 0), "no glass size");
}

static void test_passed(void)
{
    fos_touch_passed_t passed = {0};
    char buf[16 + 12 * FOS_TOUCH_PASSED_MAX];
    CHECK(fos_touch_passed_json(&passed, buf, sizeof(buf)) == 0, "none: nothing to say");
    fos_touch_passed_add(&passed, 10, 20);
    fos_touch_passed_add(&passed, 30, 40);
    CHECK(fos_touch_passed_json(&passed, buf, sizeof(buf)) > 0, "two");
    CHECK(strcmp(buf, ",\"points\":[10,20,30,40]") == 0, "oldest first");
    char small[12];
    CHECK(fos_touch_passed_json(&passed, small, sizeof(small)) == 0 && small[0] == '\0', "no room: none");

    /* A long render: every other one goes, the first and the newest stay, in order. */
    passed.count = 0;
    for (uint16_t i = 0; i < 100; i++) fos_touch_passed_add(&passed, i, (uint16_t)(1000 + i));
    CHECK(passed.count <= FOS_TOUCH_PASSED_MAX && passed.count > FOS_TOUCH_PASSED_MAX / 2, "bounded");
    CHECK(passed.xy[0] == 0 && passed.xy[1] == 1000, "the first stays");
    CHECK(passed.xy[2 * (passed.count - 1)] == 99, "the newest stays");
    bool ordered = true;
    for (uint8_t i = 1; i < passed.count; i++) ordered = ordered && passed.xy[2 * i] > passed.xy[2 * (i - 1)];
    CHECK(ordered, "in order");
    CHECK(fos_touch_passed_json(&passed, buf, sizeof(buf)) > 0, "a full set fits the payload's room");
}

static void test_edge_swipe(void)
{
    /* The scene's pixels (utils/image.nim panelToScenePoint): an 800x480
     * panel turned 270 (the reTerminal Sticky) is a 480x800 scene whose
     * bottom is the panel's left side. */
    int sx, sy, sw, sh;
    fos_touch_scene_point(2, 300, 800, 480, 270, &sx, &sy, &sw, &sh);
    CHECK(sw == 480 && sh == 800 && sx == 179 && sy == 2, "270: the panel's left is the scene's top");
    CHECK(fos_touch_edge_at(sx, sy, sw, sh) == FOS_TOUCH_EDGE_TOP, "270: so it is the top edge");
    fos_touch_scene_point(797, 300, 800, 480, 270, &sx, &sy, &sw, &sh);
    CHECK(fos_touch_edge_at(sx, sy, sw, sh) == FOS_TOUCH_EDGE_BOTTOM, "270: the panel's right, the bottom");
    fos_touch_scene_point(2, 300, 800, 480, 90, &sx, &sy, &sw, &sh);
    CHECK(sx == 300 && sy == 797 && fos_touch_edge_at(sx, sy, sw, sh) == FOS_TOUCH_EDGE_BOTTOM, "90: the left, the bottom");
    fos_touch_scene_point(10, 20, 800, 480, 180, &sx, &sy, &sw, &sh);
    CHECK(sx == 789 && sy == 459 && sw == 800 && sh == 480, "180: turned about");
    fos_touch_scene_point(10, 20, 800, 480, 0, &sx, &sy, &sw, &sh);
    CHECK(sx == 10 && sy == 20, "0: as it is");
    /* The dispatcher's rule (input_state.nim edgeAt / edgeTravel). */
    CHECK(fos_touch_edge_at(400, 2, 800, 480) == FOS_TOUCH_EDGE_TOP, "near the top");
    CHECK(fos_touch_edge_at(400, 479, 800, 480) == FOS_TOUCH_EDGE_BOTTOM, "the last row is the bottom");
    CHECK(fos_touch_edge_at(400, 479 - FOS_GESTURE_EDGE_PX, 800, 480) == FOS_TOUCH_EDGE_NONE, "past the band");
    CHECK(fos_touch_edge_at(0, 240, 800, 480) == FOS_TOUCH_EDGE_LEFT, "the left");
    CHECK(fos_touch_edge_at(799, 240, 800, 480) == FOS_TOUCH_EDGE_RIGHT, "the right");
    CHECK(fos_touch_edge_at(1, 5, 800, 480) == FOS_TOUCH_EDGE_LEFT, "a corner: the nearest");
    CHECK(fos_touch_edge_at(400, 240, 800, 480) == FOS_TOUCH_EDGE_NONE, "the middle");
    CHECK(fos_touch_edge_at(0, 0, 80, 80) == FOS_TOUCH_EDGE_NONE, "too small a panel has no edges");
    CHECK(fos_touch_edge_step(FOS_TOUCH_EDGE_BOTTOM, 3, -10) == 0, "a little up: not yet");
    CHECK(fos_touch_edge_step(FOS_TOUCH_EDGE_BOTTOM, 10, -FOS_GESTURE_SWIPE_MIN_PX) == 1, "far enough up: a swipe");
    CHECK(fos_touch_edge_step(FOS_TOUCH_EDGE_TOP, 0, FOS_GESTURE_SWIPE_MIN_PX + 5) == 1, "down from the top");
    CHECK(fos_touch_edge_step(FOS_TOUCH_EDGE_TOP, 0, -30) == 0, "out past the edge: nothing");
    CHECK(fos_touch_edge_step(FOS_TOUCH_EDGE_BOTTOM, 60, -50) == -1, "more along than inward: a drag");
    CHECK(fos_touch_edge_step(FOS_TOUCH_EDGE_LEFT, 30, FOS_GESTURE_TAP_SLOP_PX + 20) == -1, "along the left edge");
    CHECK(fos_touch_edge_step(FOS_TOUCH_EDGE_RIGHT, -FOS_GESTURE_SWIPE_MIN_PX, 0) == 1, "in from the right");
/* The Hynitron CST92xx (the AMOLED 1.75's CST9217): two five-byte records,
 * the second after the count and the ack byte. */
static void test_decode_cst92(void)
{
    fos_touch_point_t points[FOS_TOUCH_POINTS_MAX];
    uint8_t r[FOS_TOUCH_CST92_REPORT_BYTES];
    /* One finger down at (233, 400): x 0x0E9, y 0x190. */
    memset(r, 0, sizeof(r));
    r[0] = 0x06; /* id 0, down */
    r[1] = 0x0E;
    r[2] = 0x19;
    r[3] = 0x90;
    r[5] = 0x01;
    r[6] = FOS_TOUCH_CST92_ACK;
    CHECK(fos_touch_decode_cst92(r, sizeof(r), points, FOS_TOUCH_POINTS_MAX) == 1, "one finger");
    CHECK(points[0].id == 0 && points[0].x == 233 && points[0].y == 400, "point %u (%u,%u)", points[0].id,
          points[0].x, points[0].y);
    /* A second finger at (10, 20), id 1, after the two extra bytes. */
    r[5] = 0x02;
    r[7] = 0x16;
    r[8] = 0x00;
    r[9] = 0x01;
    r[10] = 0xA4;
    CHECK(fos_touch_decode_cst92(r, sizeof(r), points, FOS_TOUCH_POINTS_MAX) == 2, "two fingers");
    CHECK(points[1].id == 1 && points[1].x == 10 && points[1].y == 20, "second point %u (%u,%u)", points[1].id,
          points[1].x, points[1].y);
    CHECK(fos_touch_decode_cst92(r, sizeof(r), points, 1) == 1, "capped to the caller's room");
    /* The first finger lifted (event 0): only the second is down. */
    r[0] = 0x01; /* id 0, not down */
    CHECK(fos_touch_decode_cst92(r, sizeof(r), points, FOS_TOUCH_POINTS_MAX) == 1, "a lifted finger is not down");
    /* All lifted. */
    r[0] = 0x00;
    CHECK(fos_touch_decode_cst92(r, sizeof(r), points, FOS_TOUCH_POINTS_MAX) == 0, "no finger");
    /* The host's own ack read back: nothing new. */
    r[0] = FOS_TOUCH_CST92_ACK;
    CHECK(fos_touch_decode_cst92(r, sizeof(r), points, FOS_TOUCH_POINTS_MAX) == -1, "stale report");
    /* All 0xFF between reports while a finger moves: nothing new, no lift. */
    uint8_t blank[FOS_TOUCH_CST92_REPORT_BYTES];
    memset(blank, 0xFF, sizeof(blank));
    CHECK(fos_touch_decode_cst92(blank, sizeof(blank), points, FOS_TOUCH_POINTS_MAX) == -1, "blank read");
    /* No ack byte where it belongs: noise, not a lift. */
    r[0] = 0x06;
    r[6] = 0x00;
    CHECK(fos_touch_decode_cst92(r, sizeof(r), points, FOS_TOUCH_POINTS_MAX) == -1, "no ack byte");
    r[6] = FOS_TOUCH_CST92_ACK;
    r[5] = 0x05;
    CHECK(fos_touch_decode_cst92(r, sizeof(r), points, FOS_TOUCH_POINTS_MAX) == -1, "count past two refused");
    CHECK(fos_touch_decode_cst92(r, 7, points, FOS_TOUCH_POINTS_MAX) == -1, "short buffer");
    CHECK(fos_touch_decode_cst92(NULL, 0, points, 1) == -1, "NULL report");
}

int main(void)
{
    test_edge_swipe();
    test_decode_cst92();
    test_passed();
    test_touch_beep();
    test_decode();
    test_decode_ft();
    test_wire();
    test_axes();
    test_move_slot();
    test_glided();
    printf("%s: %d checks, %d failures\n", g_failures ? "FAILED" : "ok", g_checks, g_failures);
    return g_failures == 0 ? 0 : 1;
}

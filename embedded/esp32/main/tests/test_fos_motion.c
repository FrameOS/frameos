/*
 * Host tests for fos_motion.c: an accelerometer's readings to tilt, flick,
 * shake and orientation (docs/accelerometer.md), and a board's axes.
 *
 * Build and run (from embedded/esp32/):
 *
 *   cc -std=c11 -Wall -Wextra -Werror -O2 -Imain main/fos_motion.c \
 *      main/tests/test_fos_motion.c -o /tmp/test_fos_motion && /tmp/test_fos_motion
 *
 * (backend/app/tasks/tests/test_esp32_motion.py does exactly that in CI.)
 */
#include <math.h>
#include <stdio.h>
#include <string.h>

#include "fos_events_gen.h"
#include "fos_motion.h"

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

#define STEP_MS 20

typedef struct {
    fos_motion_t m;
    uint32_t now;
    int rotate, base;
    fos_motion_event_t seen[64];
    int count;
} rig_t;

static void rig_init(rig_t *r, int rotate, int base)
{
    memset(r, 0, sizeof(*r));
    fos_motion_init(&r->m);
    r->rotate = rotate;
    r->base = base;
    r->now = 1000;
}

/* The chip's reading (a force: the opposite of gravity) for gravity `g`. */
static void feed_gravity(rig_t *r, int gx, int gy, int gz, int ms)
{
    for (int t = 0; t < ms; t += STEP_MS) {
        int reading[3] = {-gx, -gy, -gz};
        fos_motion_event_t out[FOS_MOTION_EVENTS_MAX];
        int n = fos_motion_step(&r->m, reading, r->now, r->rotate, r->base, out);
        for (int i = 0; i < n && r->count < 64; i++) r->seen[r->count++] = out[i];
        r->now += STEP_MS;
    }
}

/* Lying flat, face up, tipped `deg` degrees towards the panel's (x, y). */
static void feed_flat_tipped(rig_t *r, double deg, int towards_x, int towards_y, int ms)
{
    double a = deg * 3.14159265358979 / 180.0;
    int in_plane = (int)(1000 * sin(a)), z = -(int)(1000 * cos(a));
    feed_gravity(r, towards_x * in_plane, towards_y * in_plane, z, ms);
}

static int count_kind(const rig_t *r, fos_motion_kind_t kind)
{
    int n = 0;
    for (int i = 0; i < r->count; i++) n += r->seen[i].kind == kind;
    return n;
}

static const fos_motion_event_t *first_kind(const rig_t *r, fos_motion_kind_t kind)
{
    for (int i = 0; i < r->count; i++)
        if (r->seen[i].kind == kind) return &r->seen[i];
    return NULL;
}

static void test_rest_is_quiet(void)
{
    rig_t r;
    rig_init(&r, 0, 0);
    feed_gravity(&r, 0, 0, -1000, 3000);
    CHECK(r.count == 0, "a frame lying still says nothing (%d events)", r.count);
    int g[3];
    CHECK(fos_motion_gravity(&r.m, 0, g) && g[2] < -950, "lying face up, gravity is into the glass (z %d)", g[2]);
}

static void test_tilt_held(void)
{
    rig_t r;
    rig_init(&r, 0, 0);
    feed_gravity(&r, 0, 0, -1000, 1000);
    feed_flat_tipped(&r, 30, -1, 0, 800);
    CHECK(count_kind(&r, FOS_MOTION_TILT) == 1, "a tip to the left held is one tilt (%d)", count_kind(&r, FOS_MOTION_TILT));
    CHECK(count_kind(&r, FOS_MOTION_FLICK) == 0, "and no flick");
    const fos_motion_event_t *e = first_kind(&r, FOS_MOTION_TILT);
    CHECK(e && strcmp(e->direction, "left") == 0, "towards the left (%s)", e ? e->direction : "-");
    CHECK(e && e->x_mg < -300, "x leans left (%d)", e ? e->x_mg : 0);
    /* Held there a while longer: nothing more. Back to level: no tilt the
     * other way, the rest is still level. */
    feed_flat_tipped(&r, 30, -1, 0, 1000);
    feed_gravity(&r, 0, 0, -1000, 1500);
    CHECK(count_kind(&r, FOS_MOTION_TILT) == 1, "coming back to level is no second tilt (%d)", count_kind(&r, FOS_MOTION_TILT));
    /* Again, down: a second tilt now it has rested. */
    feed_flat_tipped(&r, 30, 0, 1, 800);
    CHECK(count_kind(&r, FOS_MOTION_TILT) == 2, "a rested frame tilts again (%d)", count_kind(&r, FOS_MOTION_TILT));
    CHECK(strcmp(r.seen[r.count - 1].direction, "down") == 0, "down (%s)", r.seen[r.count - 1].direction);
}

static void test_small_tip_is_nothing(void)
{
    rig_t r;
    rig_init(&r, 0, 0);
    feed_gravity(&r, 0, 0, -1000, 1000);
    feed_flat_tipped(&r, 10, 1, 0, 1500);
    CHECK(count_kind(&r, FOS_MOTION_TILT) + count_kind(&r, FOS_MOTION_FLICK) == 0, "ten degrees is no tilt");
}

static void test_flick(void)
{
    rig_t r;
    rig_init(&r, 0, 0);
    feed_gravity(&r, 0, 0, -1000, 1000);
    feed_flat_tipped(&r, 35, 1, 0, 160);
    feed_gravity(&r, 0, 0, -1000, 800);
    CHECK(count_kind(&r, FOS_MOTION_FLICK) == 1, "a quick tip right and back is a flick (%d)", count_kind(&r, FOS_MOTION_FLICK));
    CHECK(count_kind(&r, FOS_MOTION_TILT) == 0, "and never also a tilt");
    const fos_motion_event_t *e = first_kind(&r, FOS_MOTION_FLICK);
    CHECK(e && strcmp(e->direction, "right") == 0, "to the right (%s)", e ? e->direction : "-");
    /* A second flick once it has rested. */
    feed_flat_tipped(&r, 35, -1, 0, 160);
    feed_gravity(&r, 0, 0, -1000, 800);
    CHECK(count_kind(&r, FOS_MOTION_FLICK) == 2, "two flicks (%d)", count_kind(&r, FOS_MOTION_FLICK));
}

static void test_directions_follow_the_picture(void)
{
    /* The panel's left edge going down, with the picture drawn at 90: the
     * picture's bottom (fos_touch_scene_point's turn). */
    rig_t r;
    rig_init(&r, 90, 90);
    feed_gravity(&r, 0, 0, -1000, 1000);
    feed_flat_tipped(&r, 30, -1, 0, 800);
    const fos_motion_event_t *e = first_kind(&r, FOS_MOTION_TILT);
    CHECK(e && strcmp(e->direction, "down") == 0, "the panel's left is the picture's bottom at 90 (%s)", e ? e->direction : "-");
    int x, y;
    fos_motion_to_picture(270, 0, 1000, &x, &y);
    CHECK(x == -1000 && y == 0, "at 270 the panel's bottom is the picture's left (%d, %d)", x, y);
}

static void test_shake(void)
{
    rig_t r;
    rig_init(&r, 0, 0);
    feed_gravity(&r, 0, 0, -1000, 1000);
    for (int i = 0; i < 4; i++) {
        feed_gravity(&r, 1800, 0, -1000, 60);
        feed_gravity(&r, -1800, 0, -1000, 60);
    }
    feed_gravity(&r, 0, 0, -1000, 1200);
    CHECK(count_kind(&r, FOS_MOTION_SHAKE) == 1, "shaken is one shake (%d)", count_kind(&r, FOS_MOTION_SHAKE));
    CHECK(count_kind(&r, FOS_MOTION_TILT) + count_kind(&r, FOS_MOTION_FLICK) == 0, "and no tilt");
    const fos_motion_event_t *e = first_kind(&r, FOS_MOTION_SHAKE);
    CHECK(e && e->strength_mg > FOS_MOTION_SHAKE_MG, "as hard as it was (%d)", e ? e->strength_mg : 0);
    /* One knock is no shake. */
    feed_gravity(&r, 1800, 0, -1000, 40);
    feed_gravity(&r, 0, 0, -1000, 1200);
    CHECK(count_kind(&r, FOS_MOTION_SHAKE) == 1, "a knock is no shake (%d)", count_kind(&r, FOS_MOTION_SHAKE));
    /* Shaken again once rested. */
    for (int i = 0; i < 4; i++) {
        feed_gravity(&r, 0, 1800, -1000, 60);
        feed_gravity(&r, 0, -1800, -1000, 60);
    }
    CHECK(count_kind(&r, FOS_MOTION_SHAKE) == 2, "a second shake (%d)", count_kind(&r, FOS_MOTION_SHAKE));
}

static void test_orientation_and_upright(void)
{
    rig_t r;
    rig_init(&r, 0, 0);
    /* Standing on the panel's bottom edge: upright, at 0, learnt silently. */
    feed_gravity(&r, 0, 1000, 0, 1500);
    CHECK(count_kind(&r, FOS_MOTION_ORIENTATION) == 0, "the first position is no change");
    CHECK(fos_motion_upright_rotate(&r.m) == 0, "upright at 0 (%d)", fos_motion_upright_rotate(&r.m));
    /* Turned a quarter: standing on the panel's left edge. */
    feed_gravity(&r, -1000, 0, 0, 1500);
    const fos_motion_event_t *e = first_kind(&r, FOS_MOTION_ORIENTATION);
    CHECK(e && e->position == FOS_POSITION_TURNED_LEFT, "its left side down (%s)",
          e ? fos_motion_position_name(e->position) : "-");
    CHECK(e && e->rotate == 90, "stood upright at 90 (%d)", e ? e->rotate : -9);
    CHECK(fos_motion_upright_rotate(&r.m) == 90, "auto-rotate reads 90");
    /* Face down. */
    feed_gravity(&r, 0, 0, 1000, 1500);
    CHECK(r.count && r.seen[r.count - 1].kind == FOS_MOTION_ORIENTATION &&
              r.seen[r.count - 1].position == FOS_POSITION_FACE_DOWN,
          "face down");
    CHECK(fos_motion_upright_rotate(&r.m) == -1, "lying flat leaves the rotation alone");
    /* Named from the frame's own rotation: a Sticky set up at 270 standing
     * on the panel's right edge is upright, and on the panel's bottom edge
     * (the picture's left) turned left. */
    rig_t s;
    rig_init(&s, 270, 270);
    feed_gravity(&s, 1000, 0, 0, 1500);
    feed_gravity(&s, 0, 1000, 0, 1500);
    e = first_kind(&s, FOS_MOTION_ORIENTATION);
    CHECK(e && e->position == FOS_POSITION_TURNED_LEFT && e->rotate == 0, "a turn of its own (%s, %d)",
          e ? fos_motion_position_name(e->position) : "-", e ? e->rotate : -9);
    CHECK(s.m.position == FOS_POSITION_TURNED_LEFT, "kept");
}

static void test_payloads(void)
{
    char buf[128];
    fos_motion_event_t e = {.kind = FOS_MOTION_TILT, .direction = "left", .x_mg = -412, .y_mg = 7, .rotate = -1};
    fos_motion_payload(&e, buf, sizeof(buf));
    CHECK(strcmp(buf, "{\"direction\":\"left\",\"x\":-0.412,\"y\":0.007}") == 0, "tilt %s", buf);
    e = (fos_motion_event_t){.kind = FOS_MOTION_SHAKE, .strength_mg = 1530};
    fos_motion_payload(&e, buf, sizeof(buf));
    CHECK(strcmp(buf, "{\"strength\":1.530}") == 0, "shake %s", buf);
    e = (fos_motion_event_t){.kind = FOS_MOTION_ORIENTATION, .position = FOS_POSITION_FACE_DOWN, .rotate = -1};
    fos_motion_payload(&e, buf, sizeof(buf));
    CHECK(strcmp(buf, "{\"position\":\"faceDown\"}") == 0, "face down %s", buf);
    e.position = FOS_POSITION_UPSIDE_DOWN;
    e.rotate = 180;
    fos_motion_payload(&e, buf, sizeof(buf));
    CHECK(strcmp(buf, "{\"position\":\"upsideDown\",\"rotate\":180}") == 0, "upside down %s", buf);
    CHECK(fos_motion_payload(&e, buf, 8) > 8 && strlen(buf) == 7, "a short buffer is cut, never overrun");
}

static void test_axes(void)
{
    fos_motion_axes_t axes;
    CHECK(fos_motion_parse_axes("x=-y,y=x,z=z", &axes), "parses");
    int chip[3] = {100, 200, 300}, panel[3];
    fos_motion_apply_axes(&axes, chip, panel);
    CHECK(panel[0] == -200 && panel[1] == 100 && panel[2] == 300, "applies (%d %d %d)", panel[0], panel[1], panel[2]);
    CHECK(fos_motion_parse_axes("x=x, y=-y, z=-z", &axes), "spaces are fine");
    CHECK(!fos_motion_parse_axes("x=x,y=x,z=z", &axes), "an axis twice is no map");
    CHECK(!fos_motion_parse_axes("y=x,x=y,z=z", &axes), "x, y, z in order");
    CHECK(!fos_motion_parse_axes("x=x,y=y", &axes), "all three");
    CHECK(!fos_motion_parse_axes("x=x,y=y,z=z,", &axes), "nothing after");
}

int main(void)
{
    test_rest_is_quiet();
    test_tilt_held();
    test_small_tip_is_nothing();
    test_flick();
    test_directions_follow_the_picture();
    test_shake();
    test_orientation_and_upright();
    test_payloads();
    test_axes();
    printf("%d checks, %d failures\n", g_checks, g_failures);
    return g_failures ? 1 : 0;
}

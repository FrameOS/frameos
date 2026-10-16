/*
 * Host tests for one button's timing (fos_button_timing.c): the lockout
 * debounce, and the button layer the buzzer mirrors from the dispatcher.
 *
 * Build and run (from embedded/esp32/):
 *
 *   cc -std=c11 -Wall -Wextra -Werror -O2 -Imain \
 *      main/fos_button_timing.c main/tests/test_button_timing.c \
 *      -o /tmp/test_button_timing && /tmp/test_button_timing
 *
 * (backend/app/tasks/tests/test_esp32_button_timing.py does exactly that in
 * CI.) The cases mirror docs/event-fixtures.json `inputState`, which the Nim
 * dispatcher answers: the two must agree on every press kind.
 */
#include <stdio.h>

#include "fos_button_timing.h"
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

/* Poll the line at 20 ms: `levels` is what gpio_get_level returns at each
 * poll from `start_ms`; returns the edges accepted, written into `edges`. */
static int poll(fos_button_timing_t *b, const int *levels, int count, int64_t start_ms,
                fos_button_edge_t *edges, int64_t *at)
{
    int n = 0;
    for (int i = 0; i < count; i++) {
        int64_t now = start_ms + 20 * i;
        fos_button_edge_t edge = fos_button_timing_sample(b, levels[i], now);
        if (edge == FOS_BUTTON_EDGE_NONE) continue;
        edges[n] = edge;
        at[n] = b->changed_at_ms;
        n++;
    }
    return n;
}

static void test_a_short_tap_is_an_edge_pair(void)
{
    fos_button_timing_t b;
    fos_button_timing_init(&b, 1, 0);
    /* Down for one poll (a 20 ms tap), as the old 80 ms settle never saw. */
    int levels[] = {1, 0, 1, 1, 1, 1};
    fos_button_edge_t edges[8];
    int64_t at[8];
    int n = poll(&b, levels, 6, 1000, edges, at);
    CHECK(n == 2, "a one-poll tap is two edges, got %d", n);
    CHECK(edges[0] == FOS_BUTTON_EDGE_PRESS && at[0] == 1020, "press at the poll that saw it");
    /* The release at +20 falls in the lockout; the sample at +40 counts. */
    CHECK(edges[1] == FOS_BUTTON_EDGE_RELEASE && at[1] == 1060, "release at the first poll past the lockout, got %lld",
          (long long)at[1]);
}

static void test_bounce_inside_the_lockout_is_ignored(void)
{
    fos_button_timing_t b;
    fos_button_timing_init(&b, 1, 0);
    /* The contact chatters once right after the press, then stays down. */
    int levels[] = {0, 1, 0, 0, 0, 0, 1, 1};
    fos_button_edge_t edges[8];
    int64_t at[8];
    int n = poll(&b, levels, 8, 1000, edges, at);
    CHECK(n == 2, "one press and one release, got %d", n);
    CHECK(edges[0] == FOS_BUTTON_EDGE_PRESS && at[0] == 1000, "the press");
    CHECK(edges[1] == FOS_BUTTON_EDGE_RELEASE && at[1] == 1120, "the release, 120 ms later");
}

static void test_a_fast_double_tap_is_a_double_press(void)
{
    fos_button_timing_t b;
    fos_button_timing_init(&b, 1, 0);
    CHECK(!fos_button_timing_press(&b, 1000), "the first press is a press");
    CHECK(fos_button_timing_release(&b, 1040) == 40, "held 40 ms");
    CHECK(b.tap_ended, "a short single press may start a double");
    CHECK(fos_button_timing_press(&b, 1140), "a press 100 ms after the release is the double");
    CHECK(fos_button_timing_release(&b, 1180) == 40, "held 40 ms");
    CHECK(!b.tap_ended, "the double's release starts no third");
    CHECK(!fos_button_timing_press(&b, 1300), "the third press starts over");
    fos_button_timing_release(&b, 1340);
    CHECK(fos_button_timing_press(&b, 1400), "the fourth pairs with the third");
    fos_button_timing_release(&b, 1440);
}

static void test_the_double_press_window_is_the_contracts(void)
{
    fos_button_timing_t b;
    fos_button_timing_init(&b, 1, 0);
    fos_button_timing_press(&b, 1000);
    fos_button_timing_release(&b, 1100);
    CHECK(!fos_button_timing_press(&b, 1100 + FOS_BUTTON_DOUBLE_PRESS_MS + 1), "one ms late is a press");
    fos_button_timing_release(&b, 1500);
    CHECK(fos_button_timing_press(&b, 1500 + FOS_BUTTON_DOUBLE_PRESS_MS), "on the window is a double");
    fos_button_timing_release(&b, 1900);
}

static void test_a_long_press_does_not_start_a_double(void)
{
    const int64_t L = FOS_BUTTON_LONG_PRESS_MS;
    fos_button_timing_t b;
    fos_button_timing_init(&b, 1, 0);
    fos_button_timing_press(&b, 1000);
    CHECK(fos_button_timing_hold(&b, 1000 + L - 1) == FOS_BUTTON_HOLD_NONE, "not yet");
    CHECK(fos_button_timing_hold(&b, 1000 + L) == FOS_BUTTON_HOLD_LONG, "the first longPress at longPressMs");
    CHECK(fos_button_timing_hold(&b, 1000 + L + 20) == FOS_BUTTON_HOLD_NONE, "once");
    CHECK(fos_button_timing_release(&b, 1000 + L + 100) == (uint32_t)(L + 100), "held");
    CHECK(!b.tap_ended, "a long press ends no tap");
    CHECK(!fos_button_timing_press(&b, 1000 + L + 200), "the next press is a press");
    fos_button_timing_release(&b, 1000 + L + 250);
}

static void test_a_long_press_every_whole_second(void)
{
    const int64_t L = FOS_BUTTON_LONG_PRESS_MS;
    CHECK(L == 1000, "the contract's long press is 1 s, got %lld", (long long)L);
    fos_button_timing_t b;
    fos_button_timing_init(&b, 1, 0);
    fos_button_timing_press(&b, 1000);
    CHECK(fos_button_timing_hold(&b, 1500) == FOS_BUTTON_HOLD_NONE, "nothing at half a second");
    CHECK(fos_button_timing_hold(&b, 2000) == FOS_BUTTON_HOLD_LONG, "the first at 1 s");
    CHECK(b.longs == 1, "one");
    CHECK(fos_button_timing_hold(&b, 2500) == FOS_BUTTON_HOLD_NONE, "nothing between");
    CHECK(fos_button_timing_hold(&b, 3000) == FOS_BUTTON_HOLD_LONG, "the second at 2 s");
    /* The task was starved for a while: one catch-up, not a burst. */
    CHECK(fos_button_timing_hold(&b, 6600) == FOS_BUTTON_HOLD_LONG, "late: one");
    CHECK(b.longs == 5, "counting the seconds, got %u", (unsigned)b.longs);
    CHECK(fos_button_timing_hold(&b, 6700) == FOS_BUTTON_HOLD_NONE, "and no more until 6 s");
    CHECK(fos_button_timing_release(&b, 6800) == 5800, "held 5800");
}

static void test_the_second_press_of_a_double_makes_no_long_press(void)
{
    fos_button_timing_t b;
    fos_button_timing_init(&b, 1, 0);
    fos_button_timing_press(&b, 1000);
    fos_button_timing_release(&b, 1040);
    CHECK(fos_button_timing_press(&b, 1140), "the double");
    CHECK(fos_button_timing_hold(&b, 3000) == FOS_BUTTON_HOLD_NONE, "a double press held is still a double press");
    fos_button_timing_release(&b, 3100);
    CHECK(!b.tap_ended, "and starts nothing");
}

static void test_a_hold_the_poll_missed_is_still_long(void)
{
    fos_button_timing_t b;
    fos_button_timing_init(&b, 1, 0);
    fos_button_timing_press(&b, 1000);
    /* No hold() call came (the task was starved); the release sees it. */
    CHECK(fos_button_timing_release(&b, 1000 + FOS_BUTTON_LONG_PRESS_MS) == FOS_BUTTON_LONG_PRESS_MS, "held");
    CHECK(!b.tap_ended, "a long press, so no double can follow");
}

static void test_a_key_held_at_boot(void)
{
    fos_button_timing_t b;
    fos_button_timing_init(&b, 0, 5000);
    CHECK(b.down, "down from the first read");
    CHECK(fos_button_timing_sample(&b, 0, 5020) == FOS_BUTTON_EDGE_NONE, "still down: no edge");
    CHECK(fos_button_timing_hold(&b, 5000 + FOS_BUTTON_LONG_PRESS_MS) == FOS_BUTTON_HOLD_LONG, "long at a second of hold");
    CHECK(fos_button_timing_sample(&b, 1, 7000) == FOS_BUTTON_EDGE_RELEASE, "the release is real");
    CHECK(fos_button_timing_release(&b, 7000) == 2000, "held 2000 from the first read");
}

static void test_busy_until_the_dispatcher_has_decided(void)
{
    const int64_t W = FOS_BUTTON_DOUBLE_PRESS_MS;
    fos_button_timing_t b;
    fos_button_timing_init(&b, 1, 0);
    CHECK(!fos_button_timing_busy(&b, 100, 100), "idle");
    fos_button_timing_press(&b, 1000);
    CHECK(fos_button_timing_busy(&b, 1500, 100), "down: a long press may come");
    fos_button_timing_release(&b, 1060);
    CHECK(fos_button_timing_busy(&b, 1060 + W, 0), "in the window: press or double press to come");
    CHECK(fos_button_timing_busy(&b, 1060 + W + 100, 100), "the slack covers the tick that delivers it");
    CHECK(!fos_button_timing_busy(&b, 1060 + W + 101, 100), "decided");
    /* A long press leaves nothing to decide once it is let go. */
    fos_button_timing_press(&b, 3000);
    fos_button_timing_release(&b, 3000 + FOS_BUTTON_LONG_PRESS_MS + 10);
    CHECK(!fos_button_timing_busy(&b, 3000 + FOS_BUTTON_LONG_PRESS_MS + 20, 100), "after a long press");
}

int main(void)
{
    test_a_short_tap_is_an_edge_pair();
    test_bounce_inside_the_lockout_is_ignored();
    test_a_fast_double_tap_is_a_double_press();
    test_the_double_press_window_is_the_contracts();
    test_a_long_press_does_not_start_a_double();
    test_a_long_press_every_whole_second();
    test_the_second_press_of_a_double_makes_no_long_press();
    test_a_hold_the_poll_missed_is_still_long();
    test_a_key_held_at_boot();
    test_busy_until_the_dispatcher_has_decided();
    printf("%s: %d checks, %d failures\n", g_failures ? "FAILED" : "ok", g_checks, g_failures);
    return g_failures == 0 ? 0 : 1;
}

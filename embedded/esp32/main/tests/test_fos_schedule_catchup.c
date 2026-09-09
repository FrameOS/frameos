/*
 * Host tests for the schedule's catch-up window (fos_schedule_catchup.h):
 * which wall-clock minutes one tick evaluates after a render held the
 * task, a deep sleep, a scheduled reboot, or an NTP step.
 *
 * Build and run (from embedded/esp32/):
 *
 *   cc -std=c11 -Wall -Wextra -Werror -O2 -Imain \
 *      main/tests/test_fos_schedule_catchup.c \
 *      -o /tmp/test_fos_schedule_catchup && /tmp/test_fos_schedule_catchup
 *
 * (.github/workflows/e2e-docker.yml runs exactly that in CI.)
 */
#include <stdio.h>

#include "fos_schedule_catchup.h"

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

/* One tick: returns whether anything is evaluated; fills from/last. */
static bool tick(int64_t minute_key, int64_t persisted, int64_t *last, int64_t *from)
{
    *from = -12345;
    return fos_schedule_catch_up_window(minute_key, persisted, last, from);
}

static void test_first_tick_evaluates_the_current_minute(void)
{
    int64_t last = -1, from;
    CHECK(tick(1000, -1, &last, &from), "first tick evaluated nothing");
    CHECK(from == 1000 && last == 1000, "from=%lld last=%lld, want 1000/1000", (long long)from,
          (long long)last);
}

static void test_same_minute_is_not_reevaluated(void)
{
    int64_t last = -1, from;
    tick(1000, -1, &last, &from);
    CHECK(!tick(1000, -1, &last, &from), "same minute evaluated twice");
    CHECK(last == 1000, "cursor moved: %lld", (long long)last);
}

static void test_reboot_marker_for_this_minute_suppresses_it(void)
{
    /* The 2026-09-04 double reboot: fired at minute 1000, rebooted, back
     * inside minute 1000 with the marker persisted → nothing to evaluate. */
    int64_t last = -1, from;
    CHECK(!tick(1000, 1000, &last, &from), "marked minute re-fired");
    CHECK(last == 1000, "cursor %lld, want 1000", (long long)last);
    /* …and the next minute proceeds normally. */
    CHECK(tick(1001, -1, &last, &from) && from == 1001, "minute after the marker skipped");
}

static void test_recent_reboot_marker_resumes_after_it(void)
{
    /* Marker two minutes old (a slow boot): minutes after it are evaluated,
     * the marked one is not. */
    int64_t last = -1, from;
    CHECK(tick(1002, 1000, &last, &from), "nothing evaluated after a recent marker");
    CHECK(from == 1001 && last == 1002, "from=%lld last=%lld, want 1001/1002", (long long)from,
          (long long)last);

    last = -1;
    CHECK(tick(1003, 1000, &last, &from) && from == 1001,
          "marker at the 3-minute bound ignored (from=%lld)", (long long)from);
}

static void test_stale_reboot_marker_is_ignored(void)
{
    /* Older than the marker window: honouring it would replay hours. */
    int64_t last = -1, from;
    CHECK(tick(1004, 1000, &last, &from), "stale marker evaluated nothing");
    CHECK(from == 1004, "stale marker replayed from %lld, want 1004", (long long)from);

    last = -1;
    CHECK(tick(5000, 1000, &last, &from) && from == 5000, "very stale marker replayed from %lld",
          (long long)from);
}

static void test_future_reboot_marker_is_ignored(void)
{
    /* The clock stepped back past the marker (or the marker is garbage):
     * treat as no marker rather than trusting a minute from the future. */
    int64_t last = -1, from;
    CHECK(tick(1000, 1005, &last, &from) && from == 1000, "future marker honoured (from=%lld)",
          (long long)from);
    CHECK(last == 1000, "cursor %lld", (long long)last);
}

static void test_catch_up_after_a_render_window(void)
{
    /* A 4-minute EPD refresh: minutes 1001..1004 arrive at once, oldest first. */
    int64_t last = 1000, from;
    CHECK(tick(1004, -1, &last, &from), "catch-up evaluated nothing");
    CHECK(from == 1001 && last == 1004, "from=%lld last=%lld, want 1001/1004", (long long)from,
          (long long)last);
}

static void test_catch_up_is_bounded(void)
{
    int64_t last = 1000, from;
    /* Exactly the window: 180 minutes (1001..1180) are replayed. */
    CHECK(tick(1180, -1, &last, &from) && from == 1001, "180-minute gap from %lld, want 1001",
          (long long)from);
    /* One more and only the most recent 180 are (1002..1181). */
    last = 1000;
    CHECK(tick(1181, -1, &last, &from) && from == 1002, "181-minute gap from %lld, want 1002",
          (long long)from);
    /* A night of deep sleep. */
    last = 1000;
    CHECK(tick(1000 + 8 * 60, -1, &last, &from) && from == 1000 + 8 * 60 - 179,
          "8-hour gap from %lld, want %lld", (long long)from, (long long)(1000 + 8 * 60 - 179));
    CHECK(last == 1000 + 8 * 60, "cursor %lld", (long long)last);
}

static void test_clock_stepped_backwards(void)
{
    int64_t last = 1000, from;
    CHECK(!tick(990, -1, &last, &from), "backwards step evaluated something");
    CHECK(last == 990, "cursor after a backwards step %lld, want 990", (long long)last);
    /* From there the schedule resumes without replaying 991..1000 again. */
    CHECK(tick(991, -1, &last, &from) && from == 991, "resume after a step from %lld", (long long)from);
}

static void test_the_persisted_marker_is_only_read_on_the_first_tick(void)
{
    /* Once armed, a marker value passed in (the caller passes -1, but a
     * stale one must not move the cursor either). */
    int64_t last = 1000, from;
    CHECK(tick(1001, 1000, &last, &from) && from == 1001, "marker consulted after arming");
    CHECK(tick(1002, 999, &last, &from) && from == 1002, "marker consulted after arming (2)");
}

int main(void)
{
    test_first_tick_evaluates_the_current_minute();
    test_same_minute_is_not_reevaluated();
    test_reboot_marker_for_this_minute_suppresses_it();
    test_recent_reboot_marker_resumes_after_it();
    test_stale_reboot_marker_is_ignored();
    test_future_reboot_marker_is_ignored();
    test_catch_up_after_a_render_window();
    test_catch_up_is_bounded();
    test_clock_stepped_backwards();
    test_the_persisted_marker_is_only_read_on_the_first_tick();

    printf("%d checks, %d failures\n", g_checks, g_failures);
    return g_failures == 0 ? 0 : 1;
}

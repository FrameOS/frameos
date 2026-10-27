/*
 * Host tests for animation mode's pacing (fos_animation.c): when a scene
 * animates, when the per-second work runs, which frames log in full, when the
 * next frame is due. Pure arithmetic on esp_timer microseconds.
 *
 * Build and run (from embedded/esp32/):
 *
 *   cc -std=c11 -Wall -Wextra -Werror -O2 -Imain \
 *      main/fos_animation.c main/tests/test_fos_animation.c \
 *      -o /tmp/test_fos_animation && /tmp/test_fos_animation
 *
 * (backend/app/tasks/tests/test_esp32_animation.py does exactly that in CI.)
 */
#include <stdio.h>
#include <string.h>

#include "fos_animation.h"

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

#define MS 1000LL
#define S (1000LL * 1000LL)

static void test_wanted(void)
{
    CHECK(fos_animation_wanted(1.0 / 30.0, true, false), "30 fps on an LCD animates");
    CHECK(fos_animation_wanted(0.999, true, false), "just under a second animates");
    CHECK(!fos_animation_wanted(1.0, true, false), "a second is the ordinary loop");
    CHECK(!fos_animation_wanted(0.0, true, false), "0 is no opinion, not as fast as possible");
    CHECK(!fos_animation_wanted(-1.0, true, false), "a negative interval is no opinion");
    CHECK(!fos_animation_wanted(0.04, false, false), "e-paper never animates");
    CHECK(!fos_animation_wanted(0.04, true, true), "a deep-sleeping frame never animates");
}

static void test_start_and_stop(void)
{
    fos_animation_t a;
    memset(&a, 0, sizeof(a));
    CHECK(!fos_animation_update(&a, false, 300.0, 10 * S), "staying off is no change");
    CHECK(fos_animation_update(&a, true, 1.0 / 24.0, 10 * S), "starting is a change");
    CHECK(a.active && a.period_us == 41667, "the period is the interval: %lld", (long long)a.period_us);
    CHECK(fos_animation_wait_us(&a, 10 * S) == 0, "the first frame is due at once");
    CHECK(!fos_animation_update(&a, true, 1.0 / 30.0, 11 * S), "a new interval is not a restart");
    CHECK(a.period_us == 33333, "but it retimes: %lld", (long long)a.period_us);
    CHECK(fos_animation_update(&a, false, 5.0, 12 * S), "stopping is a change");
    CHECK(!a.active && fos_animation_wait_us(&a, 12 * S) == 0, "stopped: no wait of its own");
    CHECK(fos_animation_housekeeping_due(&a, 12 * S), "stopped: every pass does its housekeeping");
    CHECK(!fos_animation_frame_quiet(&a, 12 * S), "stopped: every frame logs");
}

static void test_housekeeping_once_a_second(void)
{
    fos_animation_t a;
    memset(&a, 0, sizeof(a));
    fos_animation_update(&a, true, 1.0 / 24.0, 100 * S);
    /* The pass that starts an animation ran the pass-start work already. */
    CHECK(!fos_animation_housekeeping_due(&a, 100 * S + 40 * MS), "not again 40 ms later");
    CHECK(!fos_animation_housekeeping_due(&a, 100 * S + 999 * MS), "not within the second");
    CHECK(fos_animation_housekeeping_due(&a, 101 * S), "a second later");
    CHECK(!fos_animation_housekeeping_due(&a, 101 * S + 40 * MS), "and marked done");
}

static void test_pacing(void)
{
    fos_animation_t a;
    memset(&a, 0, sizeof(a));
    fos_animation_update(&a, true, 0.040, 0);
    /* A 15 ms frame: the next one starts 40 ms after this one did. */
    fos_animation_frame_done(&a, 0, 15 * MS);
    CHECK(fos_animation_wait_us(&a, 15 * MS) == 25 * MS, "wait out the rest: %lld",
          (long long)fos_animation_wait_us(&a, 15 * MS));
    CHECK(fos_animation_wait_us(&a, 39 * MS) == 1 * MS, "a millisecond left");
    CHECK(fos_animation_wait_us(&a, 41 * MS) == 0, "late: now");
    /* A 120 ms frame: the next one now, and the one after a period after
     * that — no burst of three to catch up. */
    fos_animation_frame_done(&a, 40 * MS, 160 * MS);
    CHECK(fos_animation_wait_us(&a, 160 * MS) == 0, "a slow frame is followed at once");
    fos_animation_frame_done(&a, 160 * MS, 170 * MS);
    CHECK(fos_animation_wait_us(&a, 170 * MS) == 30 * MS, "then the cadence again: %lld",
          (long long)fos_animation_wait_us(&a, 170 * MS));
}

static void test_logging_cadence(void)
{
    fos_animation_t a;
    memset(&a, 0, sizeof(a));
    fos_animation_stats_t stats;
    int64_t t = 50 * S;
    fos_animation_update(&a, true, 0.040, t);
    CHECK(!fos_animation_frame_quiet(&a, t), "the first frame logs: it is the render:done a deploy waits for");
    CHECK(!fos_animation_take_stats(&a, t, true, &stats), "nothing to summarise before it");
    fos_animation_frame_done(&a, t, t + 30 * MS);
    /* 249 more over the next ten seconds, 30 ms each, 40 ms apart. */
    for (int i = 1; i <= 249; i++) {
        int64_t start = t + i * 40 * MS;
        CHECK(fos_animation_frame_quiet(&a, start), "frame %d is quiet", i);
        fos_animation_frame_done(&a, start, start + 30 * MS);
    }
    int64_t loud = t + 10 * S;
    CHECK(!fos_animation_frame_quiet(&a, loud), "ten seconds on, a frame logs again");
    CHECK(fos_animation_take_stats(&a, loud, true, &stats), "with a summary");
    CHECK(stats.frames == 250, "every frame since the last full log: %u", stats.frames);
    CHECK(stats.window_us == 10 * S, "over the window: %lld", (long long)stats.window_us);
    CHECK(stats.fps_x10 == 250, "25.0 fps: %u", stats.fps_x10);
    CHECK(stats.avg_ms == 30 && stats.max_ms == 30, "30 ms each: %u / %u", stats.avg_ms, stats.max_ms);
    CHECK(stats.period_ms == 40, "the period asked for: %u", stats.period_ms);
    CHECK(fos_animation_frame_quiet(&a, loud + 40 * MS), "and the next one is quiet again");
    fos_animation_frame_done(&a, loud, loud + 80 * MS);
    /* Stopping reports the partial window without starting a new one. */
    fos_animation_update(&a, false, 2.0, loud + 1 * S);
    CHECK(fos_animation_take_stats(&a, loud + 1 * S, false, &stats), "the stop has a summary");
    CHECK(stats.frames == 1 && stats.max_ms == 80, "of what ran since: %u / %u", stats.frames, stats.max_ms);
}

static void test_bursts(void)
{
    /* A finger dragged over a scene that renders on its own render rule:
     * frames ~100 ms apart, outside animation. */
    fos_animation_t a;
    memset(&a, 0, sizeof(a));
    fos_animation_stats_t st;
    bool owed = true;

    /* A lone frame, long after anything: loud, with its pulls. */
    CHECK(fos_animation_housekeeping_due(&a, 50 * S), "a pass out of nowhere does its housekeeping");
    CHECK(!fos_animation_burst_quiet(&a, 50 * S), "the first frame logs in full");
    fos_animation_burst_frame_done(&a, 50 * S, 50 * S + 90 * MS, false);

    /* The next ones, 100 ms apart: quiet, the pulls once a second. */
    int64_t t = 50 * S + 100 * MS;
    CHECK(!fos_animation_housekeeping_due(&a, t), "not again within the burst's second");
    CHECK(fos_animation_burst_quiet(&a, t), "the second frame is quiet");
    fos_animation_burst_frame_done(&a, t, t + 90 * MS, true);
    CHECK(!fos_animation_burst_end(&a, t + 500 * MS, &st, &owed), "not over half a second later");
    for (int i = 0; i < 20; i++) {
        t += 100 * MS;
        bool quiet = fos_animation_burst_quiet(&a, t);
        fos_animation_burst_frame_done(&a, t, t + 90 * MS, quiet);
    }
    CHECK(fos_animation_housekeeping_due(&a, t + 100 * MS), "a second on, the pulls run once");
    CHECK(!fos_animation_housekeeping_due(&a, t + 200 * MS), "and are marked done");

    /* Ten seconds into a long drag, one frame logs in full again. */
    int64_t loud_at = 0;
    for (int i = 0; i < 100 && !loud_at; i++) {
        t += 100 * MS;
        bool quiet = fos_animation_burst_quiet(&a, t);
        if (!quiet) loud_at = t;
        fos_animation_burst_frame_done(&a, t, t + 90 * MS, quiet);
    }
    CHECK(loud_at >= 60 * S && loud_at <= 60 * S + 100 * MS, "a frame in full ten seconds in, got %lld",
          (long long)loud_at);
    t += 100 * MS;
    fos_animation_burst_frame_done(&a, t, t + 90 * MS, fos_animation_burst_quiet(&a, t));

    /* The finger lifts: a second later the burst is over, once, its last
     * frame owed its announce. */
    CHECK(!fos_animation_burst_end(&a, t + 90 * MS + 999 * MS, &st, &owed), "within the second: not over");
    CHECK(fos_animation_burst_end(&a, t + 90 * MS + 1 * S, &st, &owed), "over");
    CHECK(owed, "the last frame was quiet");
    CHECK(st.frames == 102, "every frame of the burst, got %u", (unsigned)st.frames);
    CHECK(st.avg_ms == 90 && st.max_ms == 90, "their render time");
    CHECK(!fos_animation_burst_end(&a, t + 5 * S, &st, &owed), "said once");
    CHECK(fos_animation_housekeeping_due(&a, t + 5 * S), "after it every pass does its housekeeping");

    /* A single tap is not a burst worth a line, and owes nothing. */
    fos_animation_burst_frame_done(&a, 200 * S, 200 * S + 90 * MS, false);
    CHECK(!fos_animation_burst_end(&a, 202 * S, &st, &owed), "one loud frame: nothing to say");

    /* Animating, bursts are not counted: the animation logs its own way. */
    CHECK(fos_animation_update(&a, true, 0.05, 300 * S), "starts");
    fos_animation_burst_frame_done(&a, 300 * S, 300 * S + 40 * MS, true);
    CHECK(!fos_animation_burst_quiet(&a, 300 * S + 50 * MS), "no burst while animating");
    CHECK(!fos_animation_burst_end(&a, 310 * S, &st, &owed), "and nothing ends");
}

int main(void)
{
    test_wanted();
    test_start_and_stop();
    test_housekeeping_once_a_second();
    test_pacing();
    test_logging_cadence();
    test_bursts();
    printf("%d checks, %d failures\n", g_checks, g_failures);
    return g_failures == 0 ? 0 : 1;
}

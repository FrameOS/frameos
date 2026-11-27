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

static void test_a_scene_start_is_not_a_frame(void)
{
    /* The hardware bench, 2026-11-16, SenseCAP Indicator: from the Kitchen
     * sink (animating) to the Pixel toys, whose start took 2.7 s; the window
     * after the switch said 9.2 fps, max 2736 ms, for frames of ~78 ms. */
    fos_animation_t a;
    memset(&a, 0, sizeof(a));
    fos_animation_stats_t stats;
    int64_t t = 100 * S;
    fos_animation_update(&a, true, 0.020, t);
    fos_animation_take_stats(&a, t, true, &stats); /* the first frame logs */
    fos_animation_frame_done(&a, t, t + 300 * MS);
    /* The switch's frame logs in full, so the window starts at it. */
    int64_t loud = t + 2 * S;
    CHECK(fos_animation_take_stats(&a, loud, true, &stats), "the old scene's frames are summarised");
    fos_animation_scene_started(&a, loud, loud + 2700 * MS);
    CHECK(fos_animation_wait_us(&a, loud + 2700 * MS) == 0, "the first frame of it is due at once");
    int64_t at = loud + 2700 * MS;
    for (int i = 0; i < 90; i++) {
        fos_animation_frame_done(&a, at, at + 80 * MS);
        at += 80 * MS;
    }
    CHECK(fos_animation_take_stats(&a, at, true, &stats), "a summary");
    CHECK(stats.frames == 90, "the animation's frames, not the start: %u", stats.frames);
    CHECK(stats.max_ms == 80, "the start is not the slowest frame: %u", stats.max_ms);
    CHECK(stats.avg_ms == 80, "nor in the average: %u", stats.avg_ms);
    CHECK(stats.window_us == 90 * 80 * MS, "nor in the window: %lld", (long long)stats.window_us);
    CHECK(stats.fps_x10 == 125, "12.5 fps: %u", stats.fps_x10);
    /* The window after that one starts clean. */
    fos_animation_frame_done(&a, at, at + 80 * MS);
    CHECK(fos_animation_take_stats(&a, at + 80 * MS, true, &stats), "the next summary");
    CHECK(stats.window_us == 80 * MS && stats.frames == 1, "has no start in it: %lld",
          (long long)stats.window_us);
    /* Outside animation a start is nobody's business here. */
    fos_animation_update(&a, false, 5.0, at + 1 * S);
    fos_animation_scene_started(&a, at + 1 * S, at + 3 * S);
    CHECK(a.started_us == 0, "stopped: nothing counted");
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

static void test_a_fast_loop_is_a_burst(void)
{
    CHECK(fos_animation_fast_loop(0.05, false), "a 0.05 s scene on e-paper is a fast loop");
    CHECK(fos_animation_fast_loop(0.999, false), "just under a second is one");
    CHECK(!fos_animation_fast_loop(1.0, false), "a second is the ordinary loop");
    CHECK(!fos_animation_fast_loop(0.0, false), "0 is no opinion");
    CHECK(!fos_animation_fast_loop(0.05, true), "an animation logs its own way");

    /* The Kitchen sink on the reTerminal Sticky: one pass a second, a
     * ~100 ms render, and now and then a pass whose pulls hold its frame
     * back (1.8 s between one frame's end and the next one's start). */
    fos_animation_t a;
    memset(&a, 0, sizeof(a));
    fos_animation_stats_t st;
    bool owed = false;
    int64_t t = 100 * S;
    int loud = 0, frames = 0;
    for (int i = 0; i < 60; i++) {
        fos_animation_set_loop(&a, true);
        bool quiet = fos_animation_burst_quiet(&a, t);
        if (!quiet) loud++;
        frames++;
        fos_animation_burst_frame_done(&a, t, t + 100 * MS, quiet);
        CHECK(!fos_animation_burst_end(&a, t + 900 * MS, &st, &owed), "the loop goes on at pass %d", i);
        t += (i % 7 == 6) ? 1900 * MS : 1 * S;
    }
    CHECK(loud >= 5 && loud <= 7, "one frame in ten seconds in full, got %d of %d", loud, frames);
    CHECK(fos_animation_steady(&a, t), "the passes are steady");

    /* The scene goes back to a minute: the burst ends on its own second. */
    fos_animation_set_loop(&a, false);
    CHECK(!fos_animation_burst_end(&a, t - 1 * S + 100 * MS + 999 * MS, &st, &owed), "within the second: not over");
    CHECK(fos_animation_burst_end(&a, t + 100 * MS, &st, &owed), "over");
    CHECK(st.frames == 60, "every frame of the loop, got %u", (unsigned)st.frames);
    CHECK(!fos_animation_steady(&a, t + 5 * S), "not steady after it");

    /* Animating: never a loop. */
    CHECK(fos_animation_update(&a, true, 0.05, 400 * S), "starts");
    fos_animation_set_loop(&a, true);
    CHECK(!a.loop, "an animation is no fast loop");
    CHECK(fos_animation_steady(&a, 400 * S), "but it is steady");
}

static void test_input_hold(void)
{
    fos_input_hold_t h = {0};
    CHECK(!fos_input_hold_engaged(&h), "no hold before any input");
    CHECK(!fos_input_hold_release(&h, 100 * S), "nothing to release");

    fos_input_hold_note(&h, 100 * S);
    CHECK(fos_input_hold_engaged(&h), "a tap holds the network back");
    CHECK(!fos_input_hold_release(&h, 109 * S), "still inside the quiet window");
    fos_input_hold_note(&h, 109 * S);
    CHECK(!fos_input_hold_release(&h, 118 * S), "another tap extends it");
    CHECK(fos_input_hold_release(&h, 119 * S), "released ten quiet seconds after the last tap");
    CHECK(!fos_input_hold_engaged(&h), "and over");
    CHECK(!fos_input_hold_release(&h, 120 * S), "released once");

    /* Tapping without a pause: the cap lets the held work through, and the
     * next tap starts a new hold. */
    for (int64_t t = 200; t < 260; t++) {
        fos_input_hold_note(&h, t * S);
        CHECK(!fos_input_hold_release(&h, t * S), "held at %lld s", (long long)t);
    }
    fos_input_hold_note(&h, 260 * S);
    CHECK(fos_input_hold_release(&h, 260 * S), "a minute is the most it holds");
    fos_input_hold_note(&h, 261 * S);
    CHECK(fos_input_hold_engaged(&h), "a new hold");
    CHECK(!fos_input_hold_release(&h, 262 * S), "with its own minute");
}

static void test_loading_taps(void)
{
    CHECK(fos_loading_taps_wanted(false, true, false, 100 * S, 105 * S), "someone just asked");
    CHECK(!fos_loading_taps_wanted(false, true, false, 0, 105 * S), "nobody has touched it");
    CHECK(!fos_loading_taps_wanted(false, true, false, 100 * S, 110 * S), "a schedule, ten seconds after a tap");
    CHECK(!fos_loading_taps_wanted(true, true, false, 100 * S, 105 * S), "an LCD draws its mark");
    CHECK(!fos_loading_taps_wanted(false, false, false, 100 * S, 105 * S), "the owner turned the sounds off");
    CHECK(!fos_loading_taps_wanted(false, true, true, 100 * S, 105 * S), "a voice session has the buzzer");
}

static void test_who_the_input_hold_is_for(void)
{
    /* The SenseCAP Indicator: an LCD with a touch screen and no partial
     * refresh. A settings pull between taps held each one 2.5 to 3.5 s. */
    CHECK(fos_input_hold_applies(false, true, false), "a touch LCD");
    /* The E1002 and the PhotoPainter: keys, a full-refresh panel. */
    CHECK(fos_input_hold_applies(false, false, true), "a board with keys");
    CHECK(fos_input_hold_applies(true, false, false), "a partial-refresh panel");
    CHECK(fos_input_hold_applies(true, true, true), "the Sticky and the E1003: all three");
    CHECK(!fos_input_hold_applies(false, false, false), "nobody can tap a bare panel");
}

static void test_quick_pictures_go_up_fast(void)
{
    const int64_t s = 1000000;
    /* The Kitchen sink's Motion page asks for 0.05 s: fast from its first
     * frame, however long the frame before it took to go up. */
    CHECK(fos_pictures_fast(0.05, 0, 100 * s), "an animation, its first frame");
    CHECK(fos_pictures_fast(0.05, 10 * s, 100 * s), "an animation after a long refresh");
    /* A clock's second hand. */
    CHECK(fos_pictures_fast(1.0, 0, 100 * s), "a scene that asks every second");
    CHECK(!fos_pictures_fast(2.5, 0, 100 * s), "2.5 s is the settle's own wait: not quick");
    CHECK(!fos_pictures_fast(60.0, 0, 100 * s), "a minute's scene, alone");
    CHECK(!fos_pictures_fast(0.0, 0, 100 * s), "a scene with no interval, alone");
    /* Pictures somebody else asked for, close together (an editor's slider):
     * fast while they keep coming, slow again after a pause. */
    CHECK(fos_pictures_fast(60.0, 99 * s, 100 * s), "a second after the last picture");
    CHECK(fos_pictures_fast(0.0, 98 * s, 100 * s - 1), "just under 2.5 s after it");
    CHECK(!fos_pictures_fast(60.0, 97 * s, 100 * s), "3 s after it");
    CHECK(!fos_pictures_fast(60.0, 0, 1 * s), "no picture yet");
}

static void test_the_picture_push_gives_way(void)
{
    /* On the render task: each thing that wants it back stops the push. */
    CHECK(fos_image_push_yields(false, true, false, false), "a tap or a key");
    CHECK(fos_image_push_yields(false, false, true, false), "an event from HTTP, the cloud or the console");
    CHECK(fos_image_push_yields(false, false, false, true), "a render asked for");
    CHECK(!fos_image_push_yields(false, false, false, false), "nothing waits: the push goes on");
    /* On the backend link task nobody waits for it: it never stops there,
     * or a frame tapped every few seconds would never push a picture. */
    CHECK(!fos_image_push_yields(true, true, true, true), "the link task pushes on");
}

static void test_the_backend_link(void)
{
    CHECK(fos_backend_link_on(true, false, 1), "a frame that stays awake");
    CHECK(fos_backend_link_on(true, false, 500), "and goes on doing so");
    /* A boot's first pass: its render waits for the commands and scenes the
     * sleep held, so they are pulled on the render task first. */
    CHECK(!fos_backend_link_on(true, false, 0), "not on a boot's first pass");
    /* A frame about to deep-sleep: whatever is pulled must run before it
     * goes, and the link task would not get its turn. */
    CHECK(!fos_backend_link_on(true, true, 7), "not before a deep sleep");
    CHECK(!fos_backend_link_on(false, false, 7), "not without the task");
    /* A nudge goes where the round trips are: a backend that hung held the
     * render task for the connect timeout on every nudge. */
    CHECK(fos_commands_nudge_to_link(true, false), "while the link has them, a nudge is its pull");
    CHECK(!fos_commands_nudge_to_link(false, false), "a frame about to sleep pulls it itself");
    /* The voice relay asks for the pull and releases the panel right after:
     * its answer must be in that render. */
    CHECK(!fos_commands_nudge_to_link(true, true), "a pull wanted in the next render is the render task's");
    CHECK(!fos_commands_nudge_to_link(false, true), "and so it is without the link");
}

static void test_a_deploy_downloads_off_the_render_task(void)
{
    /* The link task pulls an answer that says sync: it downloads the set and
     * settings itself, before the render task gets the answer (a 1.48 MB
     * deploy held the Sticky's render task 42 s, 2026-11-23). */
    CHECK(fos_sync_fetch_with_pull(true, false), "a deploy waiting: fetched with the pull");
    CHECK(!fos_sync_fetch_with_pull(false, false), "nothing waiting: nothing fetched");
    CHECK(!fos_sync_fetch_with_pull(true, true), "the pull that reports never syncs again");

    /* The render task runs that answer: it takes the set first and leaves the
     * report to the link task. */
    fos_sync_plan_t p = fos_sync_plan(true, false, true, true);
    CHECK(p.take_fetched && !p.fetch_here, "the link task's set is taken, not fetched again");
    CHECK(p.report_on_link && !p.report_here, "the report is the link task's pull");

    /* The round trips came back before it ran (a deep sleep comes): the set is
     * still taken first, and this task reports before the chip sleeps. */
    p = fos_sync_plan(true, false, true, false);
    CHECK(p.take_fetched && !p.fetch_here, "fetched with the pull: taken");
    CHECK(p.report_here && !p.report_on_link, "the link is off: the render task reports");

    /* Pulled on the render task: a frame about to sleep downloads it there,
     * as nobody else will before the commands run. */
    p = fos_sync_plan(true, false, false, false);
    CHECK(p.fetch_here && !p.take_fetched, "no link: the render task downloads it");
    CHECK(p.report_here && !p.report_on_link, "and reports");
    /* The voice relay's pull here, with the link on: its render needs the set,
     * the report can wait for the link task. */
    p = fos_sync_plan(true, false, false, true);
    CHECK(p.fetch_here && p.report_on_link && !p.report_here, "the voice relay's pull");

    /* Nothing to sync, or the reporting pull's answer: the commands alone. */
    p = fos_sync_plan(false, false, false, true);
    CHECK(!p.fetch_here && !p.take_fetched && !p.report_here && !p.report_on_link, "no sync");
    p = fos_sync_plan(true, true, false, true);
    CHECK(!p.fetch_here && !p.take_fetched && !p.report_here && !p.report_on_link, "never a third pull");
    p = fos_sync_plan(true, true, false, false);
    CHECK(!p.fetch_here && !p.report_here, "never a third pull, link or not");
}

static void test_a_stroke_renders_for_the_glass(void)
{
    int64_t now = 1000 * MS;
    CHECK(fos_glass_slot_wait_us(now, 0, 120 * MS) == 0, "the glass is free: render now");
    /* A DU ends 350 ms from now and such a render takes 120 ms to its
     * upload: it starts 30 ms of margin before that. */
    CHECK(fos_glass_slot_wait_us(now, now + 350 * MS, 120 * MS) == 200 * MS, "held until 150 ms before the glass frees: %lld",
          (long long)fos_glass_slot_wait_us(now, now + 350 * MS, 120 * MS));
    CHECK(fos_glass_slot_wait_us(now, now + 350 * MS, 0) == 70 * MS, "no lead known yet: a quarter second's");
    CHECK(fos_glass_slot_wait_us(now, now + 140 * MS, 120 * MS) == 0, "too close to bother: render now");
    CHECK(fos_glass_slot_wait_us(now, now + 100 * MS, 400 * MS) == 0, "a render slower than the glass: now");
    CHECK(fos_glass_slot_wait_us(now, now + 5000 * MS, 100 * MS) == FOS_GLASS_SLOT_MAX_US, "a wrong estimate costs no more");
    CHECK(fos_glass_lead_note(0, 120 * MS) == 120 * MS, "the first sample is the lead");
    CHECK(fos_glass_lead_note(120 * MS, 200 * MS) == 140 * MS, "smoothed: %lld", (long long)fos_glass_lead_note(120 * MS, 200 * MS));
    CHECK(fos_glass_lead_note(0, 5 * MS) == 10 * MS && fos_glass_lead_note(0, 9000 * MS) == 1000 * MS, "held to 10 ms..1 s");
}

static void test_a_timed_render_waits_for_the_glass(void)
{
    /* The E1002's color refresh is 28.7 s on the display's own task. */
    CHECK(fos_idle_wait_goes_on(10 * S, 60 * S, false), "inside the interval");
    CHECK(!fos_idle_wait_goes_on(60 * S, 60 * S, false), "the interval is over");
    CHECK(fos_idle_wait_goes_on(61 * S, 60 * S, true), "over, but the glass still refreshes");
    CHECK(!fos_timed_render_waits_for_finger(59 * S, 60 * S, true), "not due yet: the wait itself goes on");
    CHECK(fos_timed_render_waits_for_finger(60 * S, 60 * S, true), "due under a finger: it waits");
    CHECK(!fos_timed_render_waits_for_finger(60 * S, 60 * S, false), "due, no finger: it runs");
    CHECK(fos_timed_render_waits_for_finger(60 * S + FOS_TIMED_UNDER_FINGER_MAX_US - 1, 60 * S, true),
          "a finger held, up to the most it waits");
    CHECK(!fos_timed_render_waits_for_finger(60 * S + FOS_TIMED_UNDER_FINGER_MAX_US, 60 * S, true),
          "a finger held longer is no tap: the timed render runs");
    CHECK(!fos_idle_wait_goes_on(89 * S, 60 * S, false), "the refresh ended: render");
}

static void test_a_layouts_second_is_a_second(void)
{
    /* A 1 s clock in a layout: the layout's wait is the clock's due time
     * minus the pass's start, a hair either side of a second. Read as "under
     * one", it was no opinion, and the frame's 300 s: the Sticky's clock
     * stood still for five minutes now and then (2026-11-10). */
    CHECK(fos_scene_interval_snap(0.99996) == 1.0, "0.99996 s is a second");
    CHECK(fos_scene_interval_snap(1.00004) == 1.0, "and so is 1.00004 s");
    CHECK(fos_scene_interval_snap(59.995) == 60.0, "a minute's clock too");
    CHECK(fos_pass_interval_seconds(fos_scene_interval_snap(0.99996)) == 1,
          "the scene's second, never the frame's 300 s");
    /* An animation on an LCD stays one (below a second, not near it), and a
     * second's clock does not start one now and then. */
    CHECK(fos_scene_interval_snap(0.5) == 0.5, "half a second is half a second");
    CHECK(fos_scene_interval_snap(0.05) == 0.05, "20 fps stays 20 fps");
    CHECK(fos_animation_wanted(0.5, true, false), "an animation");
    CHECK(!fos_animation_wanted(fos_scene_interval_snap(0.9999), true, false),
          "a layout's second does not animate an LCD");
    CHECK(fos_scene_interval_snap(1.5) == 1.5, "a second and a half is not snapped");
    CHECK(fos_scene_interval_snap(299.013) == 299.013, "nor is a wait well between seconds");
    /* No opinion: the frame's interval. */
    CHECK(fos_scene_interval_snap(0.0) == 0.0, "zero: none");
    CHECK(fos_scene_interval_snap(-3.0) == 0.0, "negative: none");
    CHECK(fos_scene_interval_snap(0.0 / 0.0) == 0.0, "NaN: none");
    CHECK(fos_pass_interval_seconds(0.0) == FOS_PASS_DEFAULT_SECONDS, "no opinion: 300 s");
    CHECK(fos_pass_interval_seconds(-1.0) == 300, "a negative is no opinion either");
    /* Under a second on e-paper: the loop's shortest, a second, not 300 s. */
    CHECK(fos_pass_interval_seconds(0.25) == 1, "a quarter second: one second");
    CHECK(fos_pass_interval_seconds(5.0) == 5, "five seconds");
    CHECK(fos_pass_interval_seconds(1.9) == 1, "whole seconds, rounded down as before");
    CHECK(fos_pass_interval_seconds(30.0 * 86400.0) == 7 * 86400, "a month: a week");
}

static void test_an_animation_is_pictured_once(void)
{
    /* Each push on an LCD hashes, copies and uploads 460 KB: the frames
     * around it took up to 115 ms instead of 75. */
    CHECK(fos_animation_push_wanted(true, false), "an animation's first picture goes");
    CHECK(!fos_animation_push_wanted(true, true), "then no more while it runs");
    CHECK(fos_animation_push_wanted(false, true), "a scene that is not animating pushes as before");
    CHECK(fos_animation_push_wanted(false, false), "and so does a new one");
}

int main(void)
{
    test_wanted();
    test_start_and_stop();
    test_housekeeping_once_a_second();
    test_pacing();
    test_logging_cadence();
    test_a_scene_start_is_not_a_frame();
    test_bursts();
    test_a_fast_loop_is_a_burst();
    test_input_hold();
    test_loading_taps();
    test_who_the_input_hold_is_for();
    test_quick_pictures_go_up_fast();
    test_the_picture_push_gives_way();
    test_the_backend_link();
    test_a_deploy_downloads_off_the_render_task();
    test_a_timed_render_waits_for_the_glass();
    test_a_stroke_renders_for_the_glass();
    test_a_layouts_second_is_a_second();
    test_an_animation_is_pictured_once();
    printf("%d checks, %d failures\n", g_checks, g_failures);
    return g_failures == 0 ? 0 : 1;
}

/*
 * Animation mode: a scene that asks for a new frame faster than once a
 * second (its `refreshInterval` below 1 s), on a display that shows a frame
 * the moment it is drawn — an LCD. E-paper keeps the whole-second loop: a
 * refresh there takes seconds whatever the scene asks.
 *
 * While animating, the render task paces frames by the interval in
 * microseconds instead of sleeping in whole seconds, and does per second what
 * it otherwise does per pass: the settings and command pulls, the battery and
 * charger reads, the Nim settings it pushes, the metrics sample. A frame is
 * logged in full (render:scene … render:done, the cloud's render announce,
 * the backend's image push) once in FOS_ANIMATION_LOG_US, with a
 * `render:animation` summary of the frames in between; the others are quiet,
 * like the Linux runner's fast-render log pause. The first frame of an
 * animation is always logged: it is the render:done a deploy waits for.
 *
 * Pure: no IDF, no clock of its own (the caller passes esp_timer time), so
 * main/tests/test_fos_animation.c runs it on the host.
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

/* The pulls, sensors and settings pushes: once a second while animating. */
#define FOS_ANIMATION_HOUSEKEEPING_US (1000LL * 1000LL)
/* One frame logged in full, with the summary of the frames before it. */
#define FOS_ANIMATION_LOG_US (10LL * 1000LL * 1000LL)

typedef struct {
    bool active;
    int64_t period_us;       /* the scene's interval */
    int64_t next_due_us;     /* when the next frame should start */
    int64_t housekeeping_us; /* the last pass that did the per-second work */
    int64_t logged_us;       /* the last frame logged in full; 0 = none yet */
    /* The frames since logged_us (the summary's window). */
    uint32_t frames;
    int64_t render_us_sum;
    int64_t render_us_max;
} fos_animation_t;

typedef struct {
    uint32_t frames;
    int64_t window_us;
    uint32_t fps_x10;     /* frames per second, times ten */
    uint32_t avg_ms;      /* render time per frame */
    uint32_t max_ms;
    uint32_t period_ms;
} fos_animation_stats_t;

/* Whether a scene interval is an animation here: positive and below a
 * second, on a display that shows frames at once, on a frame that is not
 * going to deep-sleep between them. */
bool fos_animation_wanted(double scene_interval_s, bool lcd, bool deep_sleep);

/* Once per pass, before the render: start, retime or stop. True when the
 * mode changed (the caller logs the start or the stop). Stopping leaves the
 * window's stats for fos_animation_take_stats. */
bool fos_animation_update(fos_animation_t *a, bool wanted, double scene_interval_s, int64_t now_us);

/* Whether this pass does the per-second work; true on every pass outside
 * animation. Marks it done when it answers true. */
bool fos_animation_housekeeping_due(fos_animation_t *a, int64_t now_us);

/* Whether the frame starting now is quiet (not logged in full). False for
 * the first frame of an animation and once every FOS_ANIMATION_LOG_US, and
 * always outside animation. */
bool fos_animation_frame_quiet(const fos_animation_t *a, int64_t now_us);

/* The summary of the frames since the last full log, and a new window from
 * `now_us`: call before a frame that is not quiet, and when animation stops.
 * False when there is nothing to report (no frames in the window). */
bool fos_animation_take_stats(fos_animation_t *a, int64_t now_us, bool logged_frame,
                              fos_animation_stats_t *out);

/* A frame that started at `start_us` was shown at `end_us`: counts it, and
 * the next one is due a period after this one started — at once when this
 * one took longer than that (no catch-up burst after a slow frame). */
void fos_animation_frame_done(fos_animation_t *a, int64_t start_us, int64_t end_us);

/* Microseconds until the next frame is due (0: now). 0 outside animation. */
int64_t fos_animation_wait_us(const fos_animation_t *a, int64_t now_us);

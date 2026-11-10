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
 * A burst gets the same rules: outside animation, frames the scene itself
 * asked for (its render rule after a touch or a key) that start within
 * FOS_ANIMATION_BURST_US of the last one's end. A finger dragged over the
 * Touch test asked for one every 30 ms, and each logged ~2 KB in full (the
 * console's 2 KB buffer full, at 115200 baud) and ran the per-pass pulls:
 * ~300 ms a frame on the SenseCAP Indicator for a ~90 ms render
 * (2026-10-26). In a burst the pulls run once a second and one frame in
 * FOS_ANIMATION_LOG_US logs in full, the first among them; when the burst
 * ends the caller logs its summary and, if its last frame was quiet, makes
 * up the render announce and the backend push that frame skipped.
 *
 * The input hold: on a panel that answers a tap at once, the render task
 * must not be on the network or writing to flash while someone is tapping. It
 * also drains the touch queue, so a tap made during either waits it out, and
 * the ones behind it arrive in one go. The hold starts at the first touch or key and
 * lasts until FOS_INPUT_HOLD_QUIET_US without one, FOS_INPUT_HOLD_MAX_US at
 * the most (the log queue is bounded, and a plane should hear from its frame).
 * The caller runs what it held back once, when it is released.
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
/* Frames the scene asked for this close together are one burst. */
#define FOS_ANIMATION_BURST_US (1000LL * 1000LL)

typedef struct {
    bool active;
    int64_t period_us;       /* the scene's interval */
    int64_t next_due_us;     /* when the next frame should start */
    int64_t housekeeping_us; /* the last pass that did the per-second work */
    int64_t logged_us;       /* the last frame logged in full; 0 = none yet */
    /* The frames since logged_us (the summary's window), or of the burst. */
    uint32_t frames;
    int64_t render_us_sum;
    int64_t render_us_max;
    /* A burst, outside animation. */
    int64_t burst_start_us;  /* its first frame started */
    int64_t burst_last_us;   /* its last frame ended; 0 = no burst */
    int64_t burst_logged_us; /* its last frame logged in full; 0 = none */
    bool burst_owed;         /* its last frame was quiet */
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

/* The scene's interval as the runtime reports it (frameos_nim_scene_interval),
 * made fit for the rules here. A wait a scene's rhythm works out from a due
 * time (a layout's, scene_rhythm.nim: due minus now, in seconds since boot)
 * can land a hair under a whole second: in the second before uptime reaches
 * a power of two (32, 256, 512 s...), now + 1 rounds onto the coarser grid
 * above it and the difference is 0.99999999999994. Within 10 ms of a whole
 * number of seconds it is that number. 0, a negative or a NaN: the scene has
 * no opinion (0). */
double fos_scene_interval_snap(double seconds);

/* The pass loop's interval in whole seconds: the scene's, else the frame's
 * (`frame_interval_s`, 300 s when 0). Under a second is one second: the
 * scene's still, never the frame's. A 1 s clock in a layout whose wait came
 * out 0.9999 s stood still for five minutes now and then on a reTerminal
 * Sticky (2026-11-10). At most a week. */
uint32_t fos_pass_interval_seconds(double scene_interval_s, uint32_t frame_interval_s);

/* Once per pass, before the render: start, retime or stop. True when the
 * mode changed (the caller logs the start or the stop). Stopping leaves the
 * window's stats for fos_animation_take_stats. */
bool fos_animation_update(fos_animation_t *a, bool wanted, double scene_interval_s, int64_t now_us);

/* Whether this pass does the per-second work: once a second while
 * animating or in a burst, every pass otherwise. Marks it done when it
 * answers true. */
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

/* Whether a frame the scene asked for, starting now outside animation, is
 * quiet: it is in a burst, and one of the burst's frames logged in full less
 * than FOS_ANIMATION_LOG_US ago. */
bool fos_animation_burst_quiet(const fos_animation_t *a, int64_t now_us);

/* Outside animation: a frame the scene asked for started at `start_us`,
 * ended at `end_us`, logged in full or quiet. */
void fos_animation_burst_frame_done(fos_animation_t *a, int64_t start_us, int64_t end_us, bool quiet);

#define FOS_INPUT_HOLD_QUIET_US (10 * 1000000LL)
#define FOS_INPUT_HOLD_MAX_US (60 * 1000000LL)

typedef struct {
    int64_t since_us; /* 0: not holding */
    int64_t last_input_us;
} fos_input_hold_t;

/* A touch or a key: starts the hold, or extends it. */
void fos_input_hold_note(fos_input_hold_t *h, int64_t now_us);

/* Whether the network is being held back right now. */
static inline bool fos_input_hold_engaged(const fos_input_hold_t *h) { return h->since_us != 0; }

/* True, once, when the hold is over: the caller owes what it held back. */
bool fos_input_hold_release(fos_input_hold_t *h, int64_t now_us);

/* Who the input hold is for: a partial-refresh e-paper panel, and any board
 * with a touch screen or keys. On the SenseCAP Indicator's LCD a settings pull
 * of 1.4 to 2.6 s ran on the render task between taps and held each one 2.5 to
 * 3.5 s; on the E1003 a 2.8 s one held the scene switcher's close
 * (2026-11-10). An event from HTTP, the cloud or the console notes the hold
 * like a tap does, on the same boards. */
bool fos_input_hold_applies(bool partial_panel, bool touch, bool keys);

/* Whether the picture push to the backend stops and gives the render task
 * back: a big panel's picture is 1.3 MB, 8 to 14 s on Wi-Fi (the E1003,
 * 2026-11-10), and a tap or a key, a deferred event, or a render asked for
 * must not wait it out. On the backend link task nobody is waiting. */
bool fos_image_push_yields(bool on_link_task, bool input_queued, bool events_deferred, bool render_asked);

/* Whether the backend's round trips (logs, picture push, the scenes, settings
 * and commands pulls) run on the backend link task this pass rather than on
 * the render task: a 1 s clock stood still for up to 10 s while they ran
 * there (2026-11-10). Not on a frame about to deep-sleep (the pulls must be
 * done before it goes) and not on a boot's first pass (its render waits for
 * what the sleep held). */
bool fos_backend_link_on(bool link_task, bool deep_sleep_now, uint32_t render_attempts);

/* Whether the idle wait goes on at `now_us`: until `wait_until_us`, and past
 * it while the display's own task still refreshes the glass (a timed render
 * waits for it; one somebody asks for leaves the wait by its bit). */
bool fos_idle_wait_goes_on(int64_t now_us, int64_t wait_until_us, bool panel_refreshing);

/* Whether a load starting now gets the buzzer's quiet taps
 * (fos_buzzer_loading_begin): e-paper has no loading mark to draw, and a
 * frame must not tap at a room nobody is in, so only when someone at the frame
 * touched it or pressed a key moments ago. `last_input_us` 0: nobody has. */
bool fos_loading_taps_wanted(bool lcd, bool sounds_on, bool render_held, int64_t last_input_us, int64_t now_us);

/* True once a burst is over (no frame for FOS_ANIMATION_BURST_US) that is
 * worth saying so: more than one frame, or a quiet last frame. `out` gets
 * its frames and their times, `owed` whether its last frame was quiet. */
bool fos_animation_burst_end(fos_animation_t *a, int64_t now_us, fos_animation_stats_t *out, bool *owed);

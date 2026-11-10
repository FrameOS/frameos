#include "fos_animation.h"

#include <string.h>

bool fos_animation_wanted(double scene_interval_s, bool lcd, bool deep_sleep)
{
    return lcd && !deep_sleep && scene_interval_s > 0.0 && scene_interval_s < 1.0;
}

double fos_scene_interval_snap(double seconds)
{
    if (!(seconds > 0.0)) return 0.0; /* also a NaN */
    if (seconds > 7 * 86400.0) return seconds;
    double whole = (double)(int64_t)(seconds + 0.5);
    double off = seconds - whole;
    if (off < 0) off = -off;
    return whole >= 1.0 && off < 0.01 ? whole : seconds;
}

uint32_t fos_pass_interval_seconds(double scene_interval_s, uint32_t frame_interval_s)
{
    if (!(scene_interval_s > 0.0)) return frame_interval_s ? frame_interval_s : 300;
    if (scene_interval_s < 1.0) return 1;
    if (scene_interval_s > 7 * 86400.0) return 7 * 86400;
    return (uint32_t)scene_interval_s;
}

static int64_t period_for(double scene_interval_s)
{
    int64_t period = (int64_t)(scene_interval_s * 1000000.0 + 0.5);
    return period < 1000 ? 1000 : period; /* a millisecond at least */
}

bool fos_animation_update(fos_animation_t *a, bool wanted, double scene_interval_s, int64_t now_us)
{
    if (!wanted) {
        if (!a->active) return false;
        a->active = false;
        return true;
    }
    int64_t period = period_for(scene_interval_s);
    if (a->active) {
        a->period_us = period;
        return false;
    }
    memset(a, 0, sizeof(*a));
    a->active = true;
    a->period_us = period;
    a->next_due_us = now_us;
    a->housekeeping_us = now_us;
    a->logged_us = 0;
    return true;
}

static bool in_burst(const fos_animation_t *a, int64_t now_us)
{
    return !a->active && a->burst_last_us != 0 && now_us - a->burst_last_us < FOS_ANIMATION_BURST_US;
}

bool fos_animation_housekeeping_due(fos_animation_t *a, int64_t now_us)
{
    if (!a->active && !in_burst(a, now_us)) {
        a->housekeeping_us = now_us;
        return true;
    }
    if (now_us - a->housekeeping_us < FOS_ANIMATION_HOUSEKEEPING_US) return false;
    a->housekeeping_us = now_us;
    return true;
}

bool fos_animation_frame_quiet(const fos_animation_t *a, int64_t now_us)
{
    if (!a->active || a->logged_us == 0) return false;
    return now_us - a->logged_us < FOS_ANIMATION_LOG_US;
}

bool fos_animation_take_stats(fos_animation_t *a, int64_t now_us, bool logged_frame,
                              fos_animation_stats_t *out)
{
    bool any = a->frames > 0 && a->logged_us != 0;
    if (any && out) {
        int64_t window = now_us - a->logged_us;
        out->frames = a->frames;
        out->window_us = window;
        out->fps_x10 = window > 0 ? (uint32_t)(((int64_t)a->frames * 10000000LL + window / 2) / window) : 0;
        out->avg_ms = (uint32_t)((a->render_us_sum / a->frames + 500) / 1000);
        out->max_ms = (uint32_t)((a->render_us_max + 500) / 1000);
        out->period_ms = (uint32_t)((a->period_us + 500) / 1000);
    }
    a->frames = 0;
    a->render_us_sum = 0;
    a->render_us_max = 0;
    if (logged_frame) a->logged_us = now_us;
    return any;
}

void fos_animation_frame_done(fos_animation_t *a, int64_t start_us, int64_t end_us)
{
    if (!a->active) return;
    int64_t took = end_us - start_us;
    if (took < 0) took = 0;
    a->frames++;
    a->render_us_sum += took;
    if (took > a->render_us_max) a->render_us_max = took;
    a->next_due_us = start_us + a->period_us;
    if (a->next_due_us < end_us) a->next_due_us = end_us;
}

int64_t fos_animation_wait_us(const fos_animation_t *a, int64_t now_us)
{
    if (!a->active) return 0;
    int64_t wait = a->next_due_us - now_us;
    return wait > 0 ? wait : 0;
}

bool fos_animation_burst_quiet(const fos_animation_t *a, int64_t now_us)
{
    return in_burst(a, now_us) && a->burst_logged_us != 0 &&
           now_us - a->burst_logged_us < FOS_ANIMATION_LOG_US;
}

void fos_animation_burst_frame_done(fos_animation_t *a, int64_t start_us, int64_t end_us, bool quiet)
{
    if (a->active) return;
    if (!in_burst(a, start_us)) {
        a->burst_start_us = start_us;
        a->burst_logged_us = 0;
        a->frames = 0;
        a->render_us_sum = 0;
        a->render_us_max = 0;
    }
    int64_t took = end_us - start_us;
    if (took < 0) took = 0;
    a->frames++;
    a->render_us_sum += took;
    if (took > a->render_us_max) a->render_us_max = took;
    a->burst_last_us = end_us;
    if (!quiet) a->burst_logged_us = start_us;
    a->burst_owed = quiet;
}

bool fos_animation_burst_end(fos_animation_t *a, int64_t now_us, fos_animation_stats_t *out, bool *owed)
{
    if (a->active || a->burst_last_us == 0 || in_burst(a, now_us)) return false;
    bool worth = a->frames > 1 || a->burst_owed;
    if (worth && out) {
        int64_t window = a->burst_last_us - a->burst_start_us;
        out->frames = a->frames;
        out->window_us = window;
        out->fps_x10 = window > 0 ? (uint32_t)(((int64_t)a->frames * 10000000LL + window / 2) / window) : 0;
        out->avg_ms = a->frames ? (uint32_t)((a->render_us_sum / a->frames + 500) / 1000) : 0;
        out->max_ms = (uint32_t)((a->render_us_max + 500) / 1000);
        out->period_ms = 0;
    }
    if (owed) *owed = a->burst_owed;
    a->burst_last_us = 0;
    a->burst_logged_us = 0;
    a->burst_owed = false;
    a->frames = 0;
    a->render_us_sum = 0;
    a->render_us_max = 0;
    return worth;
}

void fos_input_hold_note(fos_input_hold_t *h, int64_t now_us)
{
    if (h->since_us == 0) h->since_us = now_us;
    h->last_input_us = now_us;
}

bool fos_input_hold_release(fos_input_hold_t *h, int64_t now_us)
{
    if (h->since_us == 0) return false;
    if (now_us - h->last_input_us < FOS_INPUT_HOLD_QUIET_US &&
        now_us - h->since_us < FOS_INPUT_HOLD_MAX_US) {
        return false;
    }
    h->since_us = 0;
    h->last_input_us = 0;
    return true;
}

bool fos_input_hold_applies(bool partial_panel, bool touch, bool keys)
{
    return partial_panel || touch || keys;
}

bool fos_image_push_yields(bool on_link_task, bool input_queued, bool events_deferred, bool render_asked)
{
    return !on_link_task && (input_queued || events_deferred || render_asked);
}

bool fos_animation_push_wanted(bool animating, bool scene_pushed)
{
    return !animating || !scene_pushed;
}

bool fos_backend_link_on(bool link_task, bool deep_sleep_now, uint32_t render_attempts)
{
    return link_task && !deep_sleep_now && render_attempts > 0;
}

bool fos_idle_wait_goes_on(int64_t now_us, int64_t wait_until_us, bool panel_refreshing)
{
    return now_us < wait_until_us || panel_refreshing;
}

bool fos_loading_taps_wanted(bool lcd, bool sounds_on, bool render_held, int64_t last_input_us, int64_t now_us)
{
    if (lcd || !sounds_on || render_held || last_input_us == 0) return false;
    return now_us - last_input_us < FOS_INPUT_HOLD_QUIET_US;
}

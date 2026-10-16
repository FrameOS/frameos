#include "fos_button_timing.h"

#include "fos_events_gen.h"

void fos_button_timing_init(fos_button_timing_t *b, int level, int64_t now_ms)
{
    *b = (fos_button_timing_t){
        .level = level != 0,
        .changed_at_ms = now_ms,
        .down = level == 0,
        .pressed_at_ms = now_ms,
        .released_at_ms = now_ms,
    };
}

fos_button_edge_t fos_button_timing_sample(fos_button_timing_t *b, int level, int64_t now_ms)
{
    level = level != 0;
    if (level == b->level) return FOS_BUTTON_EDGE_NONE;
    if (now_ms - b->changed_at_ms < FOS_BUTTON_LOCKOUT_MS) return FOS_BUTTON_EDGE_NONE;
    b->level = level;
    b->changed_at_ms = now_ms;
    return level == 0 ? FOS_BUTTON_EDGE_PRESS : FOS_BUTTON_EDGE_RELEASE;
}

bool fos_button_timing_press(fos_button_timing_t *b, int64_t at_ms)
{
    bool twice = b->tap_ended && at_ms - b->released_at_ms <= FOS_BUTTON_DOUBLE_PRESS_MS;
    b->tap_ended = false;
    b->down = true;
    b->pressed_at_ms = at_ms;
    b->twice = twice;
    b->seconds = 0;
    return twice;
}

bool fos_button_timing_hold_tick(fos_button_timing_t *b, int64_t now_ms)
{
    if (!b->down || b->twice) return false;
    int64_t held = now_ms - b->pressed_at_ms;
    uint32_t whole = held > 0 ? (uint32_t)(held / FOS_BUTTON_LONG_PRESS_MS) : 0;
    if (whole <= b->seconds) return false;
    b->seconds = whole;
    return true;
}

uint32_t fos_button_timing_release(fos_button_timing_t *b, int64_t at_ms, bool *long_press)
{
    int64_t held = at_ms - b->pressed_at_ms;
    bool long_hold = held >= FOS_BUTTON_LONG_PRESS_MS;
    if (long_press) *long_press = b->down && long_hold && !b->twice;
    b->tap_ended = b->down && !long_hold && !b->twice;
    b->down = false;
    b->released_at_ms = at_ms;
    b->twice = false;
    if (held < 1) held = 1;
    return held > UINT32_MAX ? UINT32_MAX : (uint32_t)held;
}

bool fos_button_timing_busy(const fos_button_timing_t *b, int64_t now_ms, int64_t slack_ms)
{
    if (b->down) return true;
    return b->tap_ended && now_ms - b->released_at_ms <= FOS_BUTTON_DOUBLE_PRESS_MS + slack_ms;
}

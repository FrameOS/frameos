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
    b->longed = false;
    b->repeats = 0;
    return twice;
}

fos_button_hold_t fos_button_timing_hold(fos_button_timing_t *b, int64_t now_ms)
{
    if (!b->down) return FOS_BUTTON_HOLD_NONE;
    int64_t held = now_ms - b->pressed_at_ms;
    if (!b->longed) {
        if (held < FOS_BUTTON_LONG_PRESS_MS) return FOS_BUTTON_HOLD_NONE;
        b->longed = true;
        return FOS_BUTTON_HOLD_LONG;
    }
    uint32_t whole = held > 0 ? (uint32_t)(held / FOS_BUTTON_REPEAT_MS) : 0;
    if (whole <= b->repeats) return FOS_BUTTON_HOLD_NONE;
    b->repeats = whole;
    return FOS_BUTTON_HOLD_REPEAT;
}

uint32_t fos_button_timing_release(fos_button_timing_t *b, int64_t at_ms)
{
    int64_t held = at_ms - b->pressed_at_ms;
    /* A hold that passed the long press without a poll noticing (the task
     * was starved) is a long press all the same, as in the dispatcher. */
    if (!b->longed && held >= FOS_BUTTON_LONG_PRESS_MS) b->longed = true;
    b->tap_ended = b->down && !b->longed && !b->twice;
    b->down = false;
    b->released_at_ms = at_ms;
    b->twice = false;
    if (held < 1) held = 1;
    return held > UINT32_MAX ? UINT32_MAX : (uint32_t)held;
}

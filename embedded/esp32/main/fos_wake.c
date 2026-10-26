#include "fos_wake.h"

uint64_t fos_wake_button_mask(const int *pins, size_t count, uint64_t valid_mask,
                              uint64_t held_mask, uint64_t *skipped_mask)
{
    uint64_t armed = 0;
    uint64_t skipped = 0;
    for (size_t i = 0; i < count; i++) {
        int pin = pins ? pins[i] : -1;
        if (pin < 0 || pin > 63) {
            continue; /* not a GPIO at all; nothing to report per pin */
        }
        uint64_t bit = 1ULL << pin;
        if ((valid_mask & bit) == 0 || (held_mask & bit) != 0) {
            skipped |= bit;
            continue;
        }
        armed |= bit;
    }
    if (skipped_mask) *skipped_mask = skipped;
    return armed;
}

int fos_wake_button_index(const int *pins, size_t count, uint64_t status_mask)
{
    int best = -1;
    for (size_t i = 0; i < count; i++) {
        int pin = pins ? pins[i] : -1;
        if (pin < 0 || pin > 63) continue;
        if ((status_mask & (1ULL << pin)) == 0) continue;
        if (best < 0 || pin < pins[best]) best = (int)i;
    }
    return best;
}

int64_t fos_wake_edge_at_ms(uint32_t at_ms_low, int64_t now_ms)
{
    uint32_t ago = (uint32_t)now_ms - at_ms_low;
    return now_ms - (int64_t)ago;
}

static int64_t next_local_boundary(int64_t local, int64_t interval)
{
    int64_t rem = local % interval;
    if (rem < 0) rem += interval;
    return local - rem + interval;
}

uint32_t fos_wake_aligned_sleep_seconds(int64_t utc_now, uint32_t interval_sec,
                                        fos_wake_offset_fn offset_minutes_at)
{
    int64_t interval = interval_sec ? (int64_t)interval_sec : 1;
    int now_offset = offset_minutes_at ? offset_minutes_at(utc_now) : 0;
    int64_t boundary = next_local_boundary(utc_now + (int64_t)now_offset * 60, interval);
    /* The next boundary under the offset in force now. */
    int64_t at = boundary - (int64_t)now_offset * 60;
    if (offset_minutes_at) {
        int then_offset = offset_minutes_at(at);
        if (then_offset != now_offset) {
            /* The offset changes before that instant. The wake is the first
             * local boundary under the new offset: the same local boundary
             * (a daily frame: local midnight, a DST hour away from where the
             * old offset put it) or an earlier one the change brings forward
             * (an hourly frame when the clocks fall back onto 02:00). */
            int64_t best = 0;
            int64_t same = boundary - (int64_t)then_offset * 60;
            if (same > utc_now && offset_minutes_at(same) == then_offset) best = same;
            int64_t earlier = next_local_boundary(utc_now + (int64_t)then_offset * 60, interval) -
                              (int64_t)then_offset * 60;
            if (earlier > utc_now && offset_minutes_at(earlier) == then_offset &&
                (best == 0 || earlier < best)) {
                best = earlier;
            }
            if (best != 0) at = best;
        }
    }
    int64_t until = at - utc_now;
    if (until <= 0) until = interval;
    if (until > (int64_t)UINT32_MAX) until = UINT32_MAX;
    return (uint32_t)until;
}

int64_t fos_wake_aligned_sleep_ms(int64_t utc_now_ms, uint32_t interval_sec,
                                  fos_wake_offset_fn offset_minutes_at)
{
    int64_t second = utc_now_ms / 1000;
    if (utc_now_ms % 1000 < 0) second--;
    uint32_t until = fos_wake_aligned_sleep_seconds(second, interval_sec, offset_minutes_at);
    return (second + (int64_t)until) * 1000 - utc_now_ms;
}

uint32_t fos_wake_slice_ticks(int64_t left_us, uint32_t max_slice_ms, uint32_t tick_ms)
{
    int64_t tick_us = (int64_t)(tick_ms ? tick_ms : 1) * 1000;
    int64_t slice_us = left_us < (int64_t)max_slice_ms * 1000 ? left_us : (int64_t)max_slice_ms * 1000;
    int64_t ticks = (slice_us + tick_us - 1) / tick_us;
    return ticks < 1 ? 1 : (uint32_t)ticks;
}

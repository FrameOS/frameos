/*
 * The schedule's catch-up window: which wall-clock minutes one tick
 * evaluates. Header-only and pure, so the arithmetic that decides whether a
 * scheduled reboot fires twice, or a 3-hour gap replays stale scene
 * changes, is host-tested (main/tests/test_fos_schedule_catchup.c) while
 * fos_schedule.c keeps the clock, the lock and the event storage.
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

/* A scheduled reboot/restart persists the minute it fired in: the board is
 * back within seconds, still inside that minute, and without the marker it
 * fired the same entry again (2026-09-04, Wood7.3: two reboots in one
 * minute). Only a marker from the last few minutes is honoured at boot; an
 * older one would make the catch-up replay hours of stale scene changes. */
#define FOS_SCHEDULE_FIRED_MARKER_MAX_MINUTES 3

/* An EPD render + refresh can hold the render task for minutes, and the
 * tick only runs between renders — so evaluation CATCHES UP over every
 * wall-clock minute since the last tick (bounded), instead of sampling only
 * the current one. Events that fell inside a render window fire late (right
 * after it), oldest first, so the last matching scene change wins the
 * display — the correct behavior for a slow e-ink frame. */
#define FOS_SCHEDULE_CATCH_UP_MAX_MINUTES 180

/* Decide the minutes [*from, minute_key] one tick evaluates.
 *
 * minute_key            the current local minute (local epoch / 60)
 * persisted_fired_minute the NVS marker a scheduled reboot left, or -1;
 *                       consulted only on the first tick (*last_fired < 0)
 * last_fired_minute     in/out: the last evaluated minute (-1 before the
 *                       first tick with a valid clock)
 * from                  out: first minute to evaluate when true is returned
 *
 * First tick: the current minute is treated as un-evaluated (arming ON the
 * minute swallowed events whose minute arrived while the clock was still
 * syncing or a render was running) — unless a fresh reboot marker names it,
 * in which case that minute has already fired. A gap longer than the
 * catch-up bound evaluates only the recent window; a clock stepped backwards
 * (NTP) evaluates nothing and resets the cursor. */
static inline bool fos_schedule_catch_up_window(int64_t minute_key,
                                                int64_t persisted_fired_minute,
                                                int64_t *last_fired_minute,
                                                int64_t *from)
{
    if (*last_fired_minute < 0) {
        if (persisted_fired_minute >= 0 && minute_key >= persisted_fired_minute &&
            minute_key - persisted_fired_minute <= FOS_SCHEDULE_FIRED_MARKER_MAX_MINUTES) {
            *last_fired_minute = persisted_fired_minute;
        } else {
            *last_fired_minute = minute_key - 1;
        }
    }
    if (minute_key == *last_fired_minute) return false;
    int64_t start = *last_fired_minute + 1;
    if (minute_key - start >= FOS_SCHEDULE_CATCH_UP_MAX_MINUTES) {
        /* A very long gap (deep sleep, NTP step): evaluate only the recent
         * window rather than replaying hours of stale scene changes. */
        start = minute_key - FOS_SCHEDULE_CATCH_UP_MAX_MINUTES + 1;
    }
    if (minute_key < start) { /* NTP stepped the clock backwards */
        *last_fired_minute = minute_key;
        return false;
    }
    *last_fired_minute = minute_key;
    *from = start;
    return true;
}

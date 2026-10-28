/*
 * Deep-sleep wakes: the pure decisions behind "a press on any registered
 * GPIO button wakes the frame" and "a wake_schedule frame wakes on the local
 * clock's interval boundary". No IDF here — fos_buttons.c and fos_client.c
 * wrap these with the chip's RTC-IO facts, the clock and the esp_sleep
 * calls, and main/tests/test_fos_wake.c argues with them on a laptop.
 *
 * Both routines speak in GPIO bit masks (bit N = GPIO N), the shape
 * esp_sleep_enable_ext1_wakeup / esp_deep_sleep_enable_gpio_wakeup and their
 * wakeup-status readers use, so nothing gets translated twice.
 */
#pragma once

#include <stddef.h>
#include <stdint.h>

/* Which of the configured button pins can be armed as deep-sleep wake
 * sources. `valid_mask` is the chip's wake-capable pin set (RTC IOs on the
 * S3, GPIO0-5 on the C3); `held_mask` names pins that currently read low —
 * arming one of those would wake the chip the instant it sleeps, so they sit
 * this sleep out. Pins outside 0..63, outside `valid_mask`, or held are
 * reported in `*skipped_mask` (may be NULL). Returns the mask to arm; 0 when
 * nothing can wake the frame. */
uint64_t fos_wake_button_mask(const int *pins, size_t count, uint64_t valid_mask,
                              uint64_t held_mask, uint64_t *skipped_mask);

/* Map a wakeup-status mask (the pins the RTC controller latched as the wake
 * cause) back to the configured button it belongs to. Returns the index into
 * `pins` of the lowest-numbered matching button, or -1 when none of the
 * latched pins is a configured button (a stale status, or a pin some other
 * subsystem armed). */
int fos_wake_button_index(const int *pins, size_t count, uint64_t status_mask);

/* The button task stamps every edge with the low 32 bits of its clock (ms
 * since boot, esp_timer) to keep the queue item small; the render task widens
 * the stamp back when it drains the queue, against its own reading of the
 * same clock. Correct for any edge younger than 2^32 ms (49 days): the
 * difference is taken in 32 bits, so a wrap between the two readings cancels.
 * A stamp that reads later than `now_ms` (the clocks are one; it cannot) is
 * treated as 2^32 ms old, which is what the arithmetic says. */
int64_t fos_wake_edge_at_ms(uint32_t at_ms_low, int64_t now_ms);

/* `wake_schedule`: seconds from `utc_now` to the next multiple of
 * `interval_sec` on the frame's LOCAL clock — a daily frame wakes at local
 * midnight, an hourly one on the local hour (which differs from UTC's in a
 * :30 zone). `offset_minutes_at(t)` is local minus UTC at UTC second `t`
 * (DST-aware, NULL = UTC). A sleep across a DST change still ends on a local
 * boundary: the daily one an hour longer or shorter than a day, the hourly
 * one on the first top of the hour the shifted clock shows. Never 0: on a
 * boundary the answer is a whole interval. interval_sec 0 counts as 1. */
typedef int (*fos_wake_offset_fn)(int64_t utc_seconds);
uint32_t fos_wake_aligned_sleep_seconds(int64_t utc_now, uint32_t interval_sec,
                                        fos_wake_offset_fn offset_minutes_at);

/* An awake frame's wait to its next render, in milliseconds where the two
 * above count whole seconds: from `utc_now_ms` to the same local boundary
 * fos_wake_aligned_sleep_seconds names for the second it falls in. In whole
 * seconds, a one-second clock whose render took half of one waited a whole
 * second more after it and showed every other second. In (0, interval]. */
int64_t fos_wake_aligned_sleep_ms(int64_t utc_now_ms, uint32_t interval_sec,
                                  fos_wake_offset_fn offset_minutes_at);

/* The render task waits for its next render in slices (fos_client.c), each an
 * xEventGroupWaitBits that a touch or a command ends early, until a deadline.
 * How many ticks of `tick_ms` the next slice waits: what is left of the wait
 * (`left_us`), at most `max_slice_ms`, rounded UP, and never 0. A wait of 0
 * ticks returns at once: at 100 Hz the last few milliseconds of a wait were
 * one, nothing passed, and the render task spun on its core until a pass
 * happened to take that long (minutes, the task watchdog's IDLE1, a clock
 * that stopped). A `tick_ms` of 0 counts as 1. */
uint32_t fos_wake_slice_ticks(int64_t left_us, uint32_t max_slice_ms, uint32_t tick_ms);

/* A deep-sleeping frame's rest after a pass that rendered. The schedule
 * counts the interval from when the render was due, so a pass (the render,
 * then the panel's refresh) that outlasts the interval leaves the next render
 * already due: the frame slept the one-second minimum, rebooted and rendered
 * again, around the clock, on a battery (a 13.3" rainbow clock: a 60 s
 * interval, 4.3 minute passes, 2026-10-27). Such a frame rests at least as
 * long as the pass took, so it works at most half the time. `left_ms` is what
 * the schedule asked for, `pass_ms` how long the pass ran. At least 1. */
uint32_t fos_wake_rest_ms(int64_t left_ms, int64_t pass_ms);

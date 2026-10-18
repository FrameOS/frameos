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

/*
 * Deep-sleep wake sources: the pure decisions behind "a press on any
 * registered GPIO button wakes the frame". No IDF here — fos_buttons.c wraps
 * these with the chip's RTC-IO facts and the esp_sleep calls, and
 * main/tests/test_fos_wake.c argues with them on a laptop.
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

#pragma once

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* heap_caps_get_largest_free_block, off the core an RGB LCD refills from.
 * The walk holds the heap's lock with the calling core's interrupts masked
 * for as long as it takes: ~1-2 ms for the PSRAM heap of a frame that has
 * run a while, longer than the refill can wait (lcd_st7701s_rgb.c: its
 * interrupt is on core 1, with the render task), so the panel scans one
 * frame from stale lines. On core 1 this runs it on core 0 (esp_ipc), where
 * the same walk takes a quarter of the time and the refill never notices
 * (SenseCAP Indicator: 274 us there, 937 us on core 1 with a late frame).
 * For every walk that recurs: the metrics sample, the animation line, a
 * decode's contiguous budget. */
size_t fos_heap_largest_free_block(uint32_t caps);

#ifdef __cplusplus
}
#endif

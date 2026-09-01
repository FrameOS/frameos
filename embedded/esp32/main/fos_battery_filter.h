/*
 * Reducing one ADC burst to a believable raw count. Pure arithmetic on
 * purpose — no IDF, no ADC — so main/tests/test_fos_battery_filter.c can
 * argue with it on a laptop. fos_battery.c drives the GPIO and the ADC and
 * feeds the numbers through here.
 *
 * Why the mean was wrong. fos_battery.c used to average 16 back-to-back
 * samples and return that. Two different faults both land as a confident,
 * far-too-low reading:
 *
 *  - A minority of samples come back near zero (the divider's enable line
 *    settling, or another task's read overlapping ours). A mean is dragged
 *    down in proportion: four zeros in sixteen turn a 4018 mV cell into
 *    3013 mV. The prod logs show exactly these ratios — E1002 and E1004
 *    reported 3062, 2558, 2036 and even 1050 mV against a true ~4000 mV,
 *    i.e. roughly a quarter, a half, three quarters of the samples lost.
 *  - The whole burst reads low because the divider had not finished
 *    charging when sampling began. Sixteen samples back to back span well
 *    under a millisecond, so they all sit at the same point on the ramp and
 *    no amount of averaging recovers the truth.
 *
 * The median inside a round handles the first; sampling in rounds spread
 * over time and keeping the HIGHEST handles the second. Taking the maximum
 * is sound because the error is one-directional: a divider still charging,
 * a sagging supply and an overlapping read can only pull a reading down,
 * never push it up. fos_client.c already relied on that when it took the
 * higher of two whole reads a moment apart; this moves the same reasoning
 * inside a single read, where it is cheap.
 *
 * A burst that has settled stops early, so a healthy cell still costs about
 * what it always did.
 */
#pragma once

#include <stdbool.h>

/* Samples per round. Odd, so the median is a real sample rather than a mean
 * of two — a mean of the middle pair reintroduces exactly the averaging this
 * module exists to avoid. */
#define FOS_BATTERY_ROUND_SAMPLES 9
/* Rounds per read, worst case. The early exit below means a settled divider
 * pays two. */
#define FOS_BATTERY_MAX_ROUNDS 4
/* Two consecutive rounds within this many raw counts of each other means the
 * divider has settled. At 12 bits over ~3.1 V with a divider of 2, one count
 * is about 1.5 mV at the cell, so 32 counts is ~48 mV — wider than ADC noise,
 * far narrower than the ramp this is looking for. */
#define FOS_BATTERY_SETTLED_COUNTS 32

/* The rounds of one read, newest last. */
typedef struct {
    int rounds[FOS_BATTERY_MAX_ROUNDS];
    int count;
} fos_battery_burst_t;

/* The median of `n` raw samples. Sorts `scratch` in place (it is the
 * caller's buffer, not a copy — this runs per read on a device). Returns -1
 * when there is nothing to take a median of. */
int fos_battery_median(int *scratch, int n);

void fos_battery_burst_reset(fos_battery_burst_t *burst);

/* Record one round's median. Returns true when the read can stop early:
 * this round and the one before it agree within FOS_BATTERY_SETTLED_COUNTS,
 * so more rounds would only repeat the same number. A round of -1 (no
 * sample came back) is not recorded and never settles the burst. */
bool fos_battery_burst_add(fos_battery_burst_t *burst, int round_median);

/* The believed raw count for the read: the highest round recorded, or -1
 * when no round produced a sample. */
int fos_battery_burst_value(const fos_battery_burst_t *burst);

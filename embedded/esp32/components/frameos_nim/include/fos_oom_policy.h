/*
 * Whether an out-of-memory abort (frameos_nim_glue.c) restarts the frame.
 *
 * A longjmp abort skips every Nim destructor on the abandoned stack, so what
 * the aborted call had allocated leaks for good. One abort is survivable;
 * the frame restarts when
 *   - the canvas a render needs no longer fits the largest free block, twice
 *     in a row,
 *   - FOS_OOM_RESTART_STREAK calls in a row aborted, or
 *   - the aborts have LEAKED more than FOS_OOM_LEAK_RESTART_PERCENT of what
 *     the frame had free after its first render (a 13.3" board once lost
 *     half its PSRAM to one abort and rendered every photo blurry for a day).
 *
 * The leak is what each abort lost: free PSRAM when the aborted call began
 * minus free PSRAM after the abort's recovery. Free memory alone said
 * nothing about a leak: a reTerminal E1003 in a switch storm had 1.65 MB of
 * its 4.88 MB baseline free, held by live scenes and caches and fragmented
 * to 328 KB blocks, and one scene load that did not fit restarted it as
 * "leaked beyond recovery" (2026-11-15).
 *
 * Pure C, host-tested (main/tests/test_fos_oom_policy.c).
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

#define FOS_OOM_RESTART_STREAK 4
#define FOS_OOM_LEAK_RESTART_PERCENT 50

/* Zero-initialised: no baseline yet, nothing leaked. */
typedef struct {
    size_t baseline; /* free PSRAM after the first healthy render; 0 before */
    size_t leaked;   /* what the aborts so far lost, summed */
    unsigned streak; /* aborts since the last healthy render */
} fos_oom_policy_t;

/* A render went through: the streak ends; the first one sets the baseline. */
void fos_oom_policy_healthy(fos_oom_policy_t *policy, size_t free_now);

/* An abort. `free_before`: free PSRAM when the aborted call began;
 * `free_after`: after the abort's recovery; `largest`: the largest free
 * block then; `canvas_bytes`: what a render's canvas needs from the heap (0
 * when nothing). True when the frame should restart. */
bool fos_oom_policy_abort(fos_oom_policy_t *policy, size_t free_before, size_t free_after,
                          size_t largest, size_t canvas_bytes);

#ifdef __cplusplus
}
#endif

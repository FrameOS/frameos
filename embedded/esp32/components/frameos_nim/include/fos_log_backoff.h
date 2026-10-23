/*
 * When the log upload may try the backend again after it did not answer.
 *
 * The upload (frameos_nim_flush_logs) runs between the steps of a render and,
 * for a long image decode, from inside it: a backend that is asleep or gone
 * used to cost every one of those flushes its full timeout. After a post the
 * backend did not answer, flushes keep their lines queued and skip the
 * network for a minute, then try again; the first answer clears it. A flat
 * minute and not a growing wait: a backend that comes back should see the
 * frame's logs within a minute, not after the longest wait so far.
 *
 * Pure C over a clock the caller passes in, so it is host-testable
 * (main/tests/test_fos_log_backoff.c).
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define FOS_LOG_BACKOFF_MS 60000u

/* Zero-initialised = no failure outstanding. */
typedef struct {
    int64_t retry_at_ms; /* when the next post may go out; 0 when it may now */
} fos_log_backoff_t;

/* True when a post may go out at now_ms. */
bool fos_log_backoff_ready(const fos_log_backoff_t *backoff, int64_t now_ms);

/* A post the backend did not answer: the next one waits FOS_LOG_BACKOFF_MS.
 * Returns that wait. */
uint32_t fos_log_backoff_failed(fos_log_backoff_t *backoff, int64_t now_ms);

/* A post the backend answered: the next flush may go out at once. */
void fos_log_backoff_succeeded(fos_log_backoff_t *backoff);

#ifdef __cplusplus
}
#endif

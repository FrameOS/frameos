/*
 * When the log upload may try the backend again after it did not answer.
 *
 * The upload (frameos_nim_flush_logs) runs between the steps of a render and,
 * for a long image decode, from inside it: a backend that is asleep or gone
 * used to cost every one of those flushes its full timeout. After a post the
 * backend did not answer, flushes keep their lines queued and skip the
 * network until the wait is over: 30 s, doubling while it stays away, at most
 * 5 min; the first answer resets it.
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

#define FOS_LOG_BACKOFF_FIRST_MS 30000u
#define FOS_LOG_BACKOFF_MAX_MS 300000u

/* Zero-initialised = no failure outstanding. */
typedef struct {
    int64_t retry_at_ms; /* when the next post may go out; 0 when it may now */
    uint32_t delay_ms;   /* the wait the last failure set */
} fos_log_backoff_t;

/* True when a post may go out at now_ms. */
bool fos_log_backoff_ready(const fos_log_backoff_t *backoff, int64_t now_ms);

/* A post the backend did not answer: sets the next wait and returns it. */
uint32_t fos_log_backoff_failed(fos_log_backoff_t *backoff, int64_t now_ms);

/* A post the backend answered: the next flush may go out at once. */
void fos_log_backoff_succeeded(fos_log_backoff_t *backoff);

#ifdef __cplusplus
}
#endif

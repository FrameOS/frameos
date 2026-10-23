#include "fos_log_backoff.h"

#include <stddef.h>

bool fos_log_backoff_ready(const fos_log_backoff_t *backoff, int64_t now_ms)
{
    return backoff == NULL || backoff->retry_at_ms == 0 || now_ms >= backoff->retry_at_ms;
}

uint32_t fos_log_backoff_failed(fos_log_backoff_t *backoff, int64_t now_ms)
{
    if (backoff == NULL) return 0;
    uint32_t delay = backoff->delay_ms == 0 ? FOS_LOG_BACKOFF_FIRST_MS
                     : backoff->delay_ms >= FOS_LOG_BACKOFF_MAX_MS / 2 ? FOS_LOG_BACKOFF_MAX_MS
                     : backoff->delay_ms * 2u;
    backoff->delay_ms = delay;
    backoff->retry_at_ms = now_ms + (int64_t)delay;
    return delay;
}

void fos_log_backoff_succeeded(fos_log_backoff_t *backoff)
{
    if (backoff == NULL) return;
    backoff->retry_at_ms = 0;
    backoff->delay_ms = 0;
}

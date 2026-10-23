#include "fos_log_backoff.h"

#include <stddef.h>

bool fos_log_backoff_ready(const fos_log_backoff_t *backoff, int64_t now_ms)
{
    return backoff == NULL || backoff->retry_at_ms == 0 || now_ms >= backoff->retry_at_ms;
}

uint32_t fos_log_backoff_failed(fos_log_backoff_t *backoff, int64_t now_ms)
{
    if (backoff == NULL) return 0;
    backoff->retry_at_ms = now_ms + (int64_t)FOS_LOG_BACKOFF_MS;
    return FOS_LOG_BACKOFF_MS;
}

void fos_log_backoff_succeeded(fos_log_backoff_t *backoff)
{
    if (backoff == NULL) return;
    backoff->retry_at_ms = 0;
}

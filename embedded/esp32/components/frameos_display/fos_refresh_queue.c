#include "fos_refresh_queue.h"

#include <string.h>

fos_refresh_put_t fos_refresh_queue_put(fos_refresh_queue_t *queue, const uint8_t *buf, size_t len)
{
    /* The picture being shown is the refresh task's: never written here. */
    uint8_t **slot = queue->busy ? &queue->next : &queue->now;
    if (*slot != NULL && len != queue->len) {
        queue->release(*slot);
        *slot = NULL;
    }
    if (*slot == NULL) *slot = queue->alloc(len);
    if (*slot == NULL) return FOS_REFRESH_NO_MEMORY;
    memcpy(*slot, buf, len);
    queue->len = len;
    if (queue->busy) return FOS_REFRESH_QUEUED;
    queue->busy = true;
    return FOS_REFRESH_STARTED;
}

const uint8_t *fos_refresh_queue_current(const fos_refresh_queue_t *queue)
{
    return queue->busy ? queue->now : NULL;
}

bool fos_refresh_queue_done(fos_refresh_queue_t *queue)
{
    if (queue->now != NULL) queue->release(queue->now);
    queue->now = queue->next;
    queue->next = NULL;
    queue->busy = queue->now != NULL;
    return queue->busy;
}

bool fos_refresh_queue_busy(const fos_refresh_queue_t *queue)
{
    return queue->busy;
}

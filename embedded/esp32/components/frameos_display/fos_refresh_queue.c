#include "fos_refresh_queue.h"

#include <string.h>

fos_refresh_put_t fos_refresh_queue_put(fos_refresh_queue_t *queue, const uint8_t *buf, size_t len)
{
    /* The picture being shown is the refresh task's: never written here. */
    uint8_t **slot = queue->busy ? &queue->next : &queue->now;
    bool *slot_lent = queue->busy ? &queue->next_lent : &queue->now_lent;
    bool lend = buf != NULL && buf == queue->lent;
    uint8_t *picture = (uint8_t *)buf;
    if (!lend) {
        /* A copy never goes into the lent buffer, and a failed allocation
         * leaves the slot as it was. */
        picture = *slot != NULL && !*slot_lent && len == queue->len ? *slot : queue->alloc(len);
        if (picture == NULL) return FOS_REFRESH_NO_MEMORY;
        memcpy(picture, buf, len);
    }
    if (*slot != NULL && !*slot_lent && *slot != picture) queue->release(*slot);
    *slot = picture;
    *slot_lent = lend;
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
    if (queue->now != NULL && !queue->now_lent) queue->release(queue->now);
    queue->now = queue->next;
    queue->now_lent = queue->next_lent;
    queue->next = NULL;
    queue->next_lent = false;
    queue->busy = queue->now != NULL;
    return queue->busy;
}

bool fos_refresh_queue_holds(const fos_refresh_queue_t *queue, const uint8_t *buf)
{
    if (buf == NULL) return false;
    return (queue->busy && queue->now == buf && queue->now_lent) || (queue->next == buf && queue->next_lent);
}

bool fos_refresh_queue_busy(const fos_refresh_queue_t *queue)
{
    return queue->busy;
}

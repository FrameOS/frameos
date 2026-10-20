#include "fos_ota_download.h"

#include <stdio.h>
#include <string.h>

void fos_ota_dl_init(fos_ota_dl_t *dl, size_t expected)
{
    memset(dl, 0, sizeof(*dl));
    dl->expected = expected;
}

bool fos_ota_dl_begin_connection(fos_ota_dl_t *dl, char *range, size_t range_len)
{
    dl->connections++;
    dl->conn_start = dl->written;
    dl->skip = 0;
    if (dl->written == 0) return false;
    snprintf(range, range_len, "bytes=%lu-", (unsigned long)dl->written);
    return true;
}

bool fos_ota_dl_accept(fos_ota_dl_t *dl, int status, int64_t content_length,
                       char *why, size_t why_len)
{
    if (status == 200) {
        /* The whole image: on a resume (a server or proxy that ignores
         * Range), read past what is already written. */
        if (dl->expected > 0 && content_length > 0 && (uint64_t)content_length != dl->expected) {
            snprintf(why, why_len, "length %lld", (long long)content_length);
            return false;
        }
        dl->skip = dl->written;
        return true;
    }
    if (status == 206 && dl->written > 0) {
        /* The rest of it. Content-Range itself is not exposed by the HTTP
         * client; the length is the check, and the signature over every
         * byte is the proof. */
        if (dl->expected > 0 && content_length > 0 &&
            (uint64_t)content_length != dl->expected - dl->written) {
            snprintf(why, why_len, "range %lld", (long long)content_length);
            return false;
        }
        return true;
    }
    snprintf(why, why_len, "http %d", status);
    return false;
}

size_t fos_ota_dl_drop(fos_ota_dl_t *dl, size_t n)
{
    size_t drop = n < dl->skip ? n : dl->skip;
    dl->skip -= drop;
    return drop;
}

bool fos_ota_dl_overflows(const fos_ota_dl_t *dl, size_t n)
{
    return dl->expected > 0 && dl->written + n > dl->expected;
}

void fos_ota_dl_wrote(fos_ota_dl_t *dl, size_t n)
{
    dl->written += n;
}

bool fos_ota_dl_complete(const fos_ota_dl_t *dl)
{
    return dl->expected > 0 && dl->written == dl->expected;
}

bool fos_ota_dl_failed(fos_ota_dl_t *dl, const char *token)
{
    snprintf(dl->last, sizeof(dl->last), "%s@%lu", token && token[0] ? token : "failed",
             (unsigned long)dl->written);
    if (dl->tries < FOS_OTA_DL_TRIES_KEPT) {
        memcpy(dl->kept[dl->tries], dl->last, sizeof(dl->last));
    } else {
        memmove(dl->kept[0], dl->kept[1], sizeof(dl->kept[0]) * (FOS_OTA_DL_TRIES_KEPT - 1));
        memcpy(dl->kept[FOS_OTA_DL_TRIES_KEPT - 1], dl->last, sizeof(dl->last));
    }
    dl->tries++;
    /* A connection that moved the download along earns the next one. */
    if (dl->written > dl->conn_start) {
        dl->stalled = 0;
    } else {
        dl->stalled++;
    }
    dl->conn_start = dl->written;
    return dl->stalled < FOS_OTA_DL_STALLED_TRIES && dl->connections < FOS_OTA_DL_MAX_CONNECTIONS;
}

void fos_ota_dl_read_token(int result, int sock_errno, char *out, size_t len)
{
    if (result == -FOS_OTA_DL_HTTP_EAGAIN) {
        snprintf(out, len, "timeout");
    } else if (sock_errno == 0) {
        snprintf(out, len, "closed");
    } else {
        snprintf(out, len, "read e%d", sock_errno);
    }
}

void fos_ota_dl_summary(const fos_ota_dl_t *dl, char *out, size_t len)
{
    int used = snprintf(out, len, "download-failed:%s/%lu", dl->tries ? dl->last : "failed@0",
                        (unsigned long)dl->expected);
    if (dl->tries < 2 || used < 0 || (size_t)used >= len) return;
    unsigned shown = dl->tries < FOS_OTA_DL_TRIES_KEPT ? dl->tries : FOS_OTA_DL_TRIES_KEPT;
    int n = dl->tries > FOS_OTA_DL_TRIES_KEPT
                ? snprintf(out + used, len - (size_t)used, " (%u tries, last %u:", dl->tries, shown)
                : snprintf(out + used, len - (size_t)used, " (%u tries:", dl->tries);
    if (n < 0 || (size_t)(used + n) >= len) return;
    used += n;
    for (unsigned i = 0; i < shown; i++) {
        n = snprintf(out + used, len - (size_t)used, "%s %s", i ? "," : "", dl->kept[i]);
        if (n < 0 || (size_t)(used + n) >= len) return;
        used += n;
    }
    snprintf(out + used, len - (size_t)used, ")");
}

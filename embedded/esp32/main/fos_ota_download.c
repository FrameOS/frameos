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
    /* 200: the whole image (on a resume, a server that ignored the Range;
     * the bytes already written are read past). 206: the rest of it.
     * Content-Range itself is not exposed by the HTTP client; the length is
     * the check, and the signature over every byte is the proof. */
    bool whole = status == 200;
    if (!whole && !(status == 206 && dl->written > 0)) {
        snprintf(why, why_len, "http %d", status);
        return false;
    }
    size_t want = whole ? dl->expected : dl->expected - dl->written;
    if (content_length > 0 && (uint64_t)content_length != want) {
        snprintf(why, why_len, "length %lld", (long long)content_length);
        return false;
    }
    dl->skip = whole ? dl->written : 0;
    return true;
}

size_t fos_ota_dl_drop(fos_ota_dl_t *dl, size_t n)
{
    size_t drop = n < dl->skip ? n : dl->skip;
    dl->skip -= drop;
    return drop;
}

bool fos_ota_dl_failed(fos_ota_dl_t *dl, const char *name)
{
    snprintf(dl->last, sizeof(dl->last), "%s@%lu", name, (unsigned long)dl->written);
    size_t used = strlen(dl->trail);
    if (used + 2 + strlen(dl->last) < sizeof(dl->trail)) {
        snprintf(dl->trail + used, sizeof(dl->trail) - used, "%s%s", used ? ", " : "", dl->last);
    }
    dl->tries++;
    /* A connection that moved the download along earns the next one. */
    dl->stalled = dl->written > dl->conn_start ? 0 : dl->stalled + 1;
    dl->conn_start = dl->written;
    return dl->stalled < FOS_OTA_DL_STALLED_TRIES && dl->connections < FOS_OTA_DL_MAX_CONNECTIONS;
}

void fos_ota_dl_read_name(int result, int sock_errno, char *out, size_t len)
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
    if (dl->tries > 1) {
        snprintf(out, len, "download-failed:%s/%lu (%u tries: %s)", dl->last,
                 (unsigned long)dl->expected, dl->tries, dl->trail);
    } else {
        snprintf(out, len, "download-failed:%s/%lu", dl->tries ? dl->last : "failed@0",
                 (unsigned long)dl->expected);
    }
}

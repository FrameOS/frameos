/* See fos_http_body.h. */
#include "fos_http_body.h"

fos_http_body_err_t fos_http_body_read(int64_t content_length, size_t max_body, size_t first_chunk,
                                       const fos_http_body_io_t *io, char **out, size_t *out_len)
{
    *out = NULL;
    *out_len = 0;
    if (content_length > (int64_t)max_body) return FOS_HTTP_BODY_TOO_LARGE;
    bool sized = content_length > 0;
    size_t cap = sized ? (size_t)content_length : max_body < first_chunk ? max_body : first_chunk;
    char *buf = io->alloc(io->ctx, cap + 1);
    if (buf == NULL) return FOS_HTTP_BODY_NO_MEMORY;
    size_t total = 0;
    for (;;) {
        /* A declared length is the whole body: read, it is done. Grown here
         * "for the end of the stream" like a chunked answer, a 430 KB scene
         * set asked for a 512 KB block it did not need, and on an 8 MB board
         * whose largest free block was 480 KB the whole read failed
         * (`read-failed`, 0 bytes, HTTP 200: the reTerminal E1003 and E1004,
         * every desktop layout's set, the hardware bench of 2026-11-16). */
        if (sized && total == cap) break;
        if (total == cap) {
            if (cap >= max_body) {
                /* More than the cap and still coming. */
                io->free(io->ctx, buf);
                return FOS_HTTP_BODY_TOO_LARGE;
            }
            size_t new_cap = cap * 2 > max_body ? max_body : cap * 2;
            char *grown = io->realloc(io->ctx, buf, new_cap + 1);
            if (grown == NULL) {
                io->free(io->ctx, buf);
                return FOS_HTTP_BODY_NO_MEMORY;
            }
            buf = grown;
            cap = new_cap;
        }
        int r = io->read(io->ctx, buf + total, (int)(cap - total));
        if (r < 0) {
            io->free(io->ctx, buf);
            return FOS_HTTP_BODY_READ_FAILED;
        }
        if (r == 0) break;
        total += (size_t)r;
    }
    if (sized && total < cap) {
        /* The connection closed before the declared length. */
        io->free(io->ctx, buf);
        return FOS_HTTP_BODY_READ_FAILED;
    }
    buf[total] = '\0';
    *out = buf;
    *out_len = total;
    return FOS_HTTP_BODY_OK;
}

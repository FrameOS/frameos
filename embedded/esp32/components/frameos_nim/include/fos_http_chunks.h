/*
 * How a response body is cut into the blocks it is buffered in
 * (frameos_nim_glue.c, fos_nim_http_request_chunked_spill).
 *
 * A body is buffered in blocks of FOS_NIM_HTTP_CHUNK_BYTES so that no
 * download needs one allocation of its whole size. A body whose length the
 * server stated gets a block of what is left of it instead: every answer
 * took 512 KB before, a 2 KB one too, and a 341 KB map held 171 KB it never
 * filled beside its own copy on a reTerminal E1004 (the hardware bench,
 * 2026-11-18). A body up to one block long is then one block, ended with a
 * NUL, which its reader can use where it lies (http_client.nim
 * boundedGetWhole).
 *
 * Pure C, host-tested (main/tests/test_fos_http_chunks.c).
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* The size to ask for the next block: `chunk_bytes` at most, never past the
 * response cap (`limit` less the `total` read so far, which the caller has
 * checked is under it), and no more than what is left of a stated
 * `content_length` (0 or less: not stated). At least 1. */
static inline size_t fos_http_chunk_want(size_t chunk_bytes, size_t limit, size_t total,
                                         int64_t content_length)
{
    size_t want = chunk_bytes;
    if (want > limit - total) want = limit - total;
    if (content_length > 0 && (uint64_t)content_length > total &&
        (uint64_t)content_length - total < want) {
        want = (size_t)((uint64_t)content_length - total);
    }
    return want < 1 ? 1 : want;
}

/* The whole of a body whose length was stated has been read: another block
 * would only be there for the read that says so. */
static inline bool fos_http_body_whole(size_t total, int64_t content_length)
{
    return content_length > 0 && total >= (uint64_t)content_length;
}

#ifdef __cplusplus
}
#endif

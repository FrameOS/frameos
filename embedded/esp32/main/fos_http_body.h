/*
 * How fos_http_fetch (fos_backend_http.c) reads an answer's body into one
 * buffer: a declared length sizes it once and is read to the byte, a chunked
 * answer grows it up to the cap. Pure C, no IDF: the read and the allocator
 * are the caller's, and the host test (tests/test_fos_http_body.c) runs it
 * against a fake socket and a heap with a largest block.
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef enum {
    FOS_HTTP_BODY_OK = 0,
    FOS_HTTP_BODY_TOO_LARGE, /* over the cap: not read */
    FOS_HTTP_BODY_NO_MEMORY, /* no buffer for it */
    FOS_HTTP_BODY_READ_FAILED, /* the read broke off, or the body was cut short of its length */
} fos_http_body_err_t;

typedef struct {
    /* Up to `len` bytes into `buf`: how many, 0 at the end, < 0 on an error. */
    int (*read)(void *ctx, char *buf, int len);
    void *(*alloc)(void *ctx, size_t bytes);
    void *(*realloc)(void *ctx, void *ptr, size_t bytes);
    void (*free)(void *ctx, void *ptr);
    void *ctx;
} fos_http_body_io_t;

/* `content_length` as the headers declared it (<= 0: unknown, read to the
 * end; esp_http_client says -1 for chunked). The first buffer of an unknown
 * length is `first_chunk` bytes. On FOS_HTTP_BODY_OK `*out` is the body,
 * NUL-terminated, and `*out_len` its length; otherwise `*out` is NULL. */
fos_http_body_err_t fos_http_body_read(int64_t content_length, size_t max_body, size_t first_chunk,
                                       const fos_http_body_io_t *io, char **out, size_t *out_len);

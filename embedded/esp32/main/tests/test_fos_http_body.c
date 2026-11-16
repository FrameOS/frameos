/*
 * How an answer's body is read into one buffer (fos_http_body.c), against a
 * fake socket and a heap whose largest free block is set by the test. Host
 * test:
 *   cc -std=c11 -Wall -Wextra -Werror -O2 -Iembedded/esp32/main \
 *     embedded/esp32/main/fos_http_body.c embedded/esp32/main/tests/test_fos_http_body.c \
 *     -o /tmp/test_fos_http_body && /tmp/test_fos_http_body
 */
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "fos_http_body.h"

typedef struct {
    const char *data;
    size_t len;     /* what the socket holds */
    size_t pos;
    int piece;      /* the most one read hands over */
    int fail_at;    /* a read at this offset fails; -1 never */
    size_t largest; /* the largest block the heap can give */
    size_t largest_asked;
    int live;       /* buffers not freed */
} fake_t;

static int fake_read(void *ctx, char *buf, int len)
{
    fake_t *f = ctx;
    if (f->fail_at >= 0 && f->pos >= (size_t)f->fail_at) return -1;
    size_t n = f->len - f->pos;
    if (n > (size_t)len) n = (size_t)len;
    if (n > (size_t)f->piece) n = (size_t)f->piece;
    memcpy(buf, f->data + f->pos, n);
    f->pos += n;
    return (int)n;
}

static void *fake_alloc(void *ctx, size_t bytes)
{
    fake_t *f = ctx;
    if (bytes > f->largest_asked) f->largest_asked = bytes;
    if (bytes > f->largest) return NULL;
    f->live++;
    return malloc(bytes);
}

static void *fake_realloc(void *ctx, void *ptr, size_t bytes)
{
    fake_t *f = ctx;
    if (bytes > f->largest_asked) f->largest_asked = bytes;
    if (bytes > f->largest) return NULL;
    return realloc(ptr, bytes);
}

static void fake_free(void *ctx, void *ptr)
{
    fake_t *f = ctx;
    if (ptr != NULL) f->live--;
    free(ptr);
}

static fos_http_body_err_t read_it(fake_t *f, int64_t content_length, size_t max_body, size_t first_chunk,
                                   char **out, size_t *out_len)
{
    fos_http_body_io_t io = {
        .read = fake_read, .alloc = fake_alloc, .realloc = fake_realloc, .free = fake_free, .ctx = f,
    };
    return fos_http_body_read(content_length, max_body, first_chunk, &io, out, out_len);
}

static char *pattern(size_t len)
{
    char *data = malloc(len);
    for (size_t i = 0; i < len; i++) data[i] = (char)('a' + i % 26);
    return data;
}

int main(void)
{
    const size_t KB = 1024;
    const size_t cap = 512 * KB;
    char *out;
    size_t out_len;

    /* The bench's case: a 432,505-byte scene set with its length declared,
     * on a heap whose largest block is 480 KB. The buffer is the body and
     * its NUL, never the cap. */
    {
        size_t len = 432505;
        char *data = pattern(len);
        fake_t f = {.data = data, .len = len, .piece = 4096, .fail_at = -1, .largest = 480 * KB};
        assert(read_it(&f, (int64_t)len, cap, 16 * KB, &out, &out_len) == FOS_HTTP_BODY_OK);
        assert(out_len == len && memcmp(out, data, len) == 0 && out[len] == '\0');
        assert(f.largest_asked == len + 1);
        fake_free(&f, out);
        assert(f.live == 0);
        free(data);
    }

    /* Exactly the cap, declared: read whole. */
    {
        char *data = pattern(cap);
        fake_t f = {.data = data, .len = cap, .piece = 65536, .fail_at = -1, .largest = cap + 1};
        assert(read_it(&f, (int64_t)cap, cap, 16 * KB, &out, &out_len) == FOS_HTTP_BODY_OK);
        assert(out_len == cap);
        fake_free(&f, out);
        free(data);
    }

    /* Declared over the cap: not read at all. */
    {
        fake_t f = {.data = "x", .len = 1, .piece = 1, .fail_at = -1, .largest = 1 << 30};
        assert(read_it(&f, (int64_t)cap + 1, cap, 16 * KB, &out, &out_len) == FOS_HTTP_BODY_TOO_LARGE);
        assert(out == NULL && f.pos == 0 && f.largest_asked == 0);
    }

    /* No block for it: no memory, nothing read, nothing held. */
    {
        size_t len = 400 * KB;
        char *data = pattern(len);
        fake_t f = {.data = data, .len = len, .piece = 4096, .fail_at = -1, .largest = 300 * KB};
        assert(read_it(&f, (int64_t)len, cap, 16 * KB, &out, &out_len) == FOS_HTTP_BODY_NO_MEMORY);
        assert(out == NULL && f.pos == 0 && f.live == 0);
        free(data);
    }

    /* Cut short of its declared length: a failed read, not half a set. */
    {
        size_t len = 100 * KB;
        char *data = pattern(len);
        fake_t f = {.data = data, .len = len - 10, .piece = 4096, .fail_at = -1, .largest = 1 << 30};
        assert(read_it(&f, (int64_t)len, cap, 16 * KB, &out, &out_len) == FOS_HTTP_BODY_READ_FAILED);
        assert(out == NULL && f.live == 0);
        free(data);
    }

    /* The read breaks off. */
    {
        size_t len = 100 * KB;
        char *data = pattern(len);
        fake_t f = {.data = data, .len = len, .piece = 4096, .fail_at = 8192, .largest = 1 << 30};
        assert(read_it(&f, (int64_t)len, cap, 16 * KB, &out, &out_len) == FOS_HTTP_BODY_READ_FAILED);
        assert(out == NULL && f.live == 0);
        free(data);
    }

    /* Chunked (no length): grows from the first chunk, doubling, to the end. */
    {
        size_t len = 100 * KB;
        char *data = pattern(len);
        fake_t f = {.data = data, .len = len, .piece = 3000, .fail_at = -1, .largest = 1 << 30};
        assert(read_it(&f, -1, cap, 16 * KB, &out, &out_len) == FOS_HTTP_BODY_OK);
        assert(out_len == len && memcmp(out, data, len) == 0 && out[len] == '\0');
        assert(f.largest_asked == 128 * KB + 1);
        fake_free(&f, out);
        assert(f.live == 0);
        free(data);
    }

    /* Chunked and longer than the cap: too large, nothing kept. */
    {
        size_t len = cap + 10;
        char *data = pattern(len);
        fake_t f = {.data = data, .len = len, .piece = 65536, .fail_at = -1, .largest = 1 << 30};
        assert(read_it(&f, -1, cap, 16 * KB, &out, &out_len) == FOS_HTTP_BODY_TOO_LARGE);
        assert(out == NULL && f.live == 0);
        free(data);
    }

    /* Chunked whose growth finds no block. */
    {
        size_t len = 100 * KB;
        char *data = pattern(len);
        fake_t f = {.data = data, .len = len, .piece = 4096, .fail_at = -1, .largest = 40 * KB};
        assert(read_it(&f, -1, cap, 16 * KB, &out, &out_len) == FOS_HTTP_BODY_NO_MEMORY);
        assert(out == NULL && f.live == 0);
        free(data);
    }

    /* An empty chunked body, and a cap under the first chunk. */
    {
        fake_t f = {.data = "", .len = 0, .piece = 1, .fail_at = -1, .largest = 1 << 30};
        assert(read_it(&f, -1, cap, 16 * KB, &out, &out_len) == FOS_HTTP_BODY_OK);
        assert(out_len == 0 && out[0] == '\0');
        fake_free(&f, out);
        fake_t g = {.data = "hello", .len = 5, .piece = 2, .fail_at = -1, .largest = 1 << 30};
        assert(read_it(&g, -1, 8, 16 * KB, &out, &out_len) == FOS_HTTP_BODY_OK);
        assert(out_len == 5 && strcmp(out, "hello") == 0 && g.largest_asked == 9);
        fake_free(&g, out);
    }

    puts("fos_http_body: ok");
    return 0;
}

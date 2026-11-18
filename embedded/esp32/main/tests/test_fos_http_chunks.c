/*
 * Host tests for how a response body is cut into the blocks it is buffered
 * in (fos_http_chunks.h, used by frameos_nim_glue.c).
 *
 * Build and run (from embedded/esp32/):
 *
 *   cc -std=c11 -Wall -Wextra -Werror -O2 -Icomponents/frameos_nim/include \
 *      main/tests/test_fos_http_chunks.c -o /tmp/test_fos_http_chunks && /tmp/test_fos_http_chunks
 *
 * (backend/app/tasks/tests/test_esp32_http_chunks.py does exactly that in CI.)
 */
#include <stdio.h>

#include "fos_http_chunks.h"

#define KB ((size_t)1024)
#define MB (KB * KB)
#define CHUNK (512 * KB)

static int checks = 0;
static int failures = 0;

#define CHECK(cond)                                                                    \
    do {                                                                               \
        checks++;                                                                      \
        if (!(cond)) {                                                                 \
            failures++;                                                                \
            printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);                    \
        }                                                                              \
    } while (0)

/* The blocks a body of `body` bytes is read into, as the glue's loop asks
 * for them; returns how many, the first one's size in `first`. */
static int blocks_for(size_t body, int64_t content_length, size_t limit, size_t *first, size_t *bytes)
{
    size_t total = 0;
    int count = 0;
    *bytes = 0;
    while (total < body) {
        if (total >= limit) break;                            /* too big: the caller's error */
        if (fos_http_body_whole(total, content_length)) break;
        size_t want = fos_http_chunk_want(CHUNK, limit, total, content_length);
        if (count == 0) *first = want;
        *bytes += want;
        count++;
        total += want < body - total ? want : body - total;
    }
    return count;
}

static void test_a_stated_length_is_one_block_of_that_size(void)
{
    /* The E1004's map: 341,366 bytes, Content-Length stated. */
    size_t first = 0, bytes = 0;
    CHECK(blocks_for(341366, 341366, 10 * MB, &first, &bytes) == 1);
    CHECK(first == 341366);
    CHECK(bytes == 341366);
    /* A weather API's 2 KB answer no longer takes 512 KB while it is read. */
    CHECK(blocks_for(2048, 2048, 10 * MB, &first, &bytes) == 1);
    CHECK(first == 2048);
}

static void test_no_block_follows_a_whole_body(void)
{
    /* The read loop came back for a block once the last was full: with the
     * block the body's own size that was every answer, for a read of 0. */
    CHECK(fos_http_body_whole(341366, 341366));
    CHECK(!fos_http_body_whole(341365, 341366));
    CHECK(!fos_http_body_whole(0, 0));           /* no body stated: read on */
    CHECK(!fos_http_body_whole(4096, -1));       /* chunked encoding: until the read says so */
    size_t first = 0, bytes = 0;
    CHECK(blocks_for(CHUNK, (int64_t)CHUNK, 10 * MB, &first, &bytes) == 1);
    CHECK(bytes == CHUNK);
}

static void test_a_long_body_is_cut_into_chunks_and_a_rest(void)
{
    size_t first = 0, bytes = 0;
    /* 1.2 MB stated: two chunks and what is left. */
    CHECK(blocks_for(1200 * KB, (int64_t)(1200 * KB), 10 * MB, &first, &bytes) == 3);
    CHECK(first == CHUNK);
    CHECK(bytes == 1200 * KB);
    CHECK(fos_http_chunk_want(CHUNK, 10 * MB, 2 * CHUNK, (int64_t)(1200 * KB)) == 1200 * KB - 2 * CHUNK);
}

static void test_an_unstated_length_keeps_whole_chunks(void)
{
    /* Chunked transfer encoding: as it always was. */
    CHECK(fos_http_chunk_want(CHUNK, 10 * MB, 0, -1) == CHUNK);
    CHECK(fos_http_chunk_want(CHUNK, 10 * MB, 0, 0) == CHUNK);
    CHECK(fos_http_chunk_want(CHUNK, 10 * MB, 3 * CHUNK, -1) == CHUNK);
}

static void test_the_response_cap_still_bounds_a_block(void)
{
    /* 100 KB allowed, 60 KB read: 40 KB more at most, whatever was stated. */
    CHECK(fos_http_chunk_want(CHUNK, 100 * KB, 60 * KB, -1) == 40 * KB);
    CHECK(fos_http_chunk_want(CHUNK, 100 * KB, 60 * KB, (int64_t)(90 * KB)) == 30 * KB);
    /* A server that sends more than it stated is read on in whole chunks
     * (the client stops at the stated length, so this is only the guard). */
    CHECK(fos_http_chunk_want(CHUNK, 10 * MB, 8 * KB, 4096) == CHUNK);
    /* Never 0: the block also holds the NUL's neighbour. */
    CHECK(fos_http_chunk_want(CHUNK, 4 * KB, 4 * KB, -1) == 1);
}

int main(void)
{
    test_a_stated_length_is_one_block_of_that_size();
    test_no_block_follows_a_whole_body();
    test_a_long_body_is_cut_into_chunks_and_a_rest();
    test_an_unstated_length_keeps_whole_chunks();
    test_the_response_cap_still_bounds_a_block();
    printf("%d checks, %d failures\n", checks, failures);
    return failures == 0 ? 0 : 1;
}

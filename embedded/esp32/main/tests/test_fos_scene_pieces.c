/*
 * A backend's scene answer read in pieces (fos_scene_pieces.c), against a
 * fake socket and a heap with a largest block. Host test:
 *   cc -std=c11 -Wall -Wextra -Werror -O2 -Iembedded/esp32/main \
 *     embedded/esp32/main/fos_scene_pieces.c embedded/esp32/main/tests/test_fos_scene_pieces.c \
 *     -o /tmp/test_fos_scene_pieces && /tmp/test_fos_scene_pieces
 */
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "fos_scene_pieces.h"

typedef struct {
    const char *data;
    size_t len;
    size_t pos;
    int piece;      /* the most one read hands over */
    int fail_at;    /* a read at this offset fails; -1 never */
    size_t largest; /* the largest block the heap gives */
    size_t largest_asked;
    int live;
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

static int checks = 0, failures = 0;
#define CHECK(cond)                                                              \
    do {                                                                         \
        checks++;                                                                \
        if (!(cond)) {                                                           \
            failures++;                                                          \
            fprintf(stderr, "%s:%d: %s\n", __FILE__, __LINE__, #cond);          \
        }                                                                        \
    } while (0)

static fos_http_body_err_t read_with(const char *text, int piece, size_t largest, int64_t declared,
                                     fos_scene_set_t *set, fake_t *f)
{
    *f = (fake_t){.data = text, .len = strlen(text), .piece = piece, .fail_at = -1, .largest = largest};
    fos_http_body_io_t io = {.read = fake_read, .alloc = fake_alloc, .realloc = fake_realloc, .free = fake_free,
                             .ctx = f};
    return fos_scene_pieces_read(declared, 1 << 20, &io, set);
}

static void release(fos_scene_set_t *set, fake_t *f)
{
    fos_http_body_io_t io = {.read = fake_read, .alloc = fake_alloc, .realloc = fake_realloc, .free = fake_free,
                             .ctx = f};
    fos_scene_pieces_free(set, &io);
    CHECK(f->live == 0);
}

/* Every read size, so a scene, a string or an escape split across two reads
 * is read as the whole. */
static void expect(const char *text, const char *rest, int count, const char **scenes)
{
    for (int piece = 1; piece <= (int)strlen(text) + 1; piece++) {
        fos_scene_set_t set;
        fake_t f;
        fos_http_body_err_t err = read_with(text, piece, 1 << 20, (int64_t)strlen(text), &set, &f);
        CHECK(err == FOS_HTTP_BODY_OK);
        if (err != FOS_HTTP_BODY_OK) {
            fprintf(stderr, "  %s at reads of %d: %d\n", text, piece, err);
            return;
        }
        CHECK(set.bytes == strlen(text));
        CHECK(strcmp(set.rest, rest) == 0);
        CHECK(set.count == count);
        for (int i = 0; i < count && i < set.count; i++) {
            CHECK(set.lens[i] == strlen(scenes[i]));
            CHECK(strcmp(set.scenes[i], scenes[i]) == 0);
        }
        release(&set, &f);
    }
}

static void expect_err(const char *text, fos_http_body_err_t want)
{
    for (int piece = 1; piece <= (int)strlen(text) + 1; piece++) {
        fos_scene_set_t set;
        fake_t f;
        CHECK(read_with(text, piece, 1 << 20, -1, &set, &f) == want);
        CHECK(set.count == 0 && set.rest == NULL);
        CHECK(f.live == 0);
    }
}

int main(void)
{
    /* A whole set: its scenes, and `[]` left. */
    const char *set2[] = {"{\"id\":\"a\",\"nodes\":[{\"x\":[1,2]}]}", "{\"id\":\"b\",\"name\":\"q]}\\\"{[\"}"};
    expect(" [ {\"id\":\"a\",\"nodes\":[{\"x\":[1,2]}]} ,\n{\"id\":\"b\",\"name\":\"q]}\\\"{[\"} ] \n", "[]", 2, set2);
    expect("[]", "[]", 0, NULL);
    /* A patch: base and order stay, the put's scenes are lifted. */
    const char *put[] = {"{\"id\":\"c\",\"put\":[1]}"};
    expect("{\"patch\":true,\"base\":\"put\",\"order\":[\"c\",\"put\"],\"put\":[{\"id\":\"c\",\"put\":[1]}]}",
           "{\"patch\":true,\"base\":\"put\",\"order\":[\"c\",\"put\"],\"put\":[]}", 1, put);
    /* A key is "put" only whole, and only at the top. */
    expect("{\"output\":[{\"a\":1}],\"x\":{\"put\":[{\"b\":2}]},\"pu\":[]}",
           "{\"output\":[{\"a\":1}],\"x\":{\"put\":[{\"b\":2}]},\"pu\":[]}", 0, NULL);
    expect("{\"p\\\"ut\":[{\"a\":1}]}", "{\"p\\\"ut\":[{\"a\":1}]}", 0, NULL);
    /* A patch with nothing to put. */
    expect("{\"base\":\"e\",\"order\":[],\"put\":[]}", "{\"base\":\"e\",\"order\":[],\"put\":[]}", 0, NULL);

    /* Not a scene answer. */
    expect_err("[1]", FOS_HTTP_BODY_INVALID);
    expect_err("[{\"id\":\"a\"}, \"b\"]", FOS_HTTP_BODY_INVALID);
    expect_err("[[{\"id\":\"a\"}]]", FOS_HTTP_BODY_INVALID);
    expect_err("{\"put\":[null]}", FOS_HTTP_BODY_INVALID);
    expect_err("[] []", FOS_HTTP_BODY_INVALID);
    expect_err("x[]", FOS_HTTP_BODY_INVALID);
    expect_err("\"[]\"", FOS_HTTP_BODY_INVALID);
    expect_err("]", FOS_HTTP_BODY_INVALID);
    /* Cut short: no closing bracket, an open string, nothing. */
    expect_err("[{\"id\":\"a\"}", FOS_HTTP_BODY_READ_FAILED);
    expect_err("[{\"id\":\"a\"", FOS_HTTP_BODY_READ_FAILED);
    expect_err("{\"put\":[{\"id\":\"a}]}", FOS_HTTP_BODY_READ_FAILED);
    expect_err("", FOS_HTTP_BODY_READ_FAILED);

    {
        /* Short of its declared length. */
        fos_scene_set_t set;
        fake_t f;
        CHECK(read_with("[{\"a\":1}]", 4, 1 << 20, 20, &set, &f) == FOS_HTTP_BODY_READ_FAILED);
        CHECK(f.live == 0);
        /* A read that fails, part way into a scene. */
        f = (fake_t){.data = "[{\"a\":1},{\"b\":2}]", .len = 17, .piece = 3, .fail_at = 12, .largest = 1 << 20};
        fos_http_body_io_t io = {.read = fake_read, .alloc = fake_alloc, .realloc = fake_realloc,
                                 .free = fake_free, .ctx = &f};
        CHECK(fos_scene_pieces_read(-1, 1 << 20, &io, &set) == FOS_HTTP_BODY_READ_FAILED);
        CHECK(f.live == 0);
        /* Declared over the cap: nothing read. */
        f = (fake_t){.data = "[]", .len = 2, .piece = 2, .fail_at = -1, .largest = 1 << 20};
        CHECK(fos_scene_pieces_read(100, 50, &io, &set) == FOS_HTTP_BODY_TOO_LARGE);
        CHECK(f.pos == 0 && f.live == 0);
        /* Over the cap as it comes (chunked). */
        char big[200];
        memset(big, ' ', sizeof(big));
        big[0] = '[';
        big[198] = ']';
        big[199] = '\0';
        f = (fake_t){.data = big, .len = 199, .piece = 64, .fail_at = -1, .largest = 1 << 20};
        CHECK(fos_scene_pieces_read(-1, 100, &io, &set) == FOS_HTTP_BODY_TOO_LARGE);
        CHECK(f.live == 0);
    }

    {
        /* More scenes than a store holds: refused, not cut. */
        char text[4096];
        for (int n = FOS_SCENE_PIECES_MAX; n <= FOS_SCENE_PIECES_MAX + 1; n++) {
            strcpy(text, "[");
            for (int i = 0; i < n; i++) {
                char one[32];
                snprintf(one, sizeof(one), "%s{\"id\":\"s%d\"}", i ? "," : "", i);
                strcat(text, one);
            }
            strcat(text, "]");
            fos_scene_set_t set;
            fake_t f;
            fos_http_body_err_t err = read_with(text, 100, 1 << 20, -1, &set, &f);
            if (n > FOS_SCENE_PIECES_MAX) {
                CHECK(err == FOS_HTTP_BODY_TOO_LARGE);
                CHECK(f.live == 0);
                continue;
            }
            /* As many as it holds: read. */
            CHECK(err == FOS_HTTP_BODY_OK);
            CHECK(set.count == FOS_SCENE_PIECES_MAX);
            CHECK(strcmp(set.scenes[FOS_SCENE_PIECES_MAX - 1], "{\"id\":\"s31\"}") == 0);
            release(&set, &f);
        }
    }

    {
        /* The point of it: a 300 KB set of 30 KB scenes asks for no block
         * near its size (the reTerminal E1004's largest was 300 KB). */
        size_t scene = 30 * 1024, n = 10;
        char *text = malloc(n * (scene + 1) + 3);
        size_t at = 0;
        text[at++] = '[';
        for (size_t i = 0; i < n; i++) {
            if (i) text[at++] = ',';
            text[at++] = '{';
            text[at++] = '"';
            memset(text + at, 'x', scene - 6);
            at += scene - 6;
            memcpy(text + at, "\":1}", 4);
            at += 4;
        }
        text[at++] = ']';
        text[at] = '\0';
        fos_scene_set_t set;
        fake_t f;
        CHECK(read_with(text, 1460, 64 * 1024, (int64_t)at, &set, &f) == FOS_HTTP_BODY_OK);
        CHECK(set.count == (int)n && set.lens[3] == scene);
        CHECK(f.largest_asked <= 64 * 1024);
        release(&set, &f);
        /* And no block for a scene: refused out of memory, nothing kept. */
        CHECK(read_with(text, 1460, 16 * 1024, (int64_t)at, &set, &f) == FOS_HTTP_BODY_NO_MEMORY);
        CHECK(f.live == 0);
        free(text);
    }

    printf("%d checks, %d failures\n", checks, failures);
    return failures ? 1 : 0;
}

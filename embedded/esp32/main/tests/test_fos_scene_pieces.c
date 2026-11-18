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

/* A sink that keeps what it is handed, and can refuse. */
typedef struct {
    char text[8192]; /* the scenes, a newline after each */
    size_t len;
    int begun, ended, calls;
    bool open;
    int fail_begin_at; /* the scene whose begin is refused; -1 never */
    int fail_bytes_at; /* the scene whose bytes are refused */
    int fail_end_at;
    bool misuse;       /* bytes or an end outside a scene, a begin inside one */
} taken_t;

static fos_http_body_err_t take_begin(void *ctx)
{
    taken_t *t = ctx;
    if (t->open) t->misuse = true;
    if (t->begun == t->fail_begin_at) return FOS_HTTP_BODY_NO_MEMORY;
    t->open = true;
    t->begun++;
    return FOS_HTTP_BODY_OK;
}

static fos_http_body_err_t take_bytes(void *ctx, const char *bytes, size_t len)
{
    taken_t *t = ctx;
    if (!t->open || len == 0) t->misuse = true;
    if (t->begun - 1 == t->fail_bytes_at) return FOS_HTTP_BODY_READ_FAILED;
    memcpy(t->text + t->len, bytes, len);
    t->len += len;
    t->calls++;
    return FOS_HTTP_BODY_OK;
}

static fos_http_body_err_t take_end(void *ctx)
{
    taken_t *t = ctx;
    if (!t->open) t->misuse = true;
    if (t->ended == t->fail_end_at) return FOS_HTTP_BODY_INVALID;
    t->open = false;
    t->text[t->len++] = '\n';
    t->ended++;
    return FOS_HTTP_BODY_OK;
}

static size_t s_counted = 0;
static fos_http_body_err_t count_bytes(void *ctx, const char *bytes, size_t len)
{
    taken_t *t = ctx;
    (void)bytes;
    if (!t->open || len == 0) t->misuse = true;
    s_counted += len;
    return FOS_HTTP_BODY_OK;
}

static fos_http_body_err_t read_to(const char *text, int piece, taken_t *taken, fos_scene_set_t *set, fake_t *f)
{
    *f = (fake_t){.data = text, .len = strlen(text), .piece = piece, .fail_at = -1, .largest = 1 << 20};
    fos_http_body_io_t io = {.read = fake_read, .alloc = fake_alloc, .realloc = fake_realloc, .free = fake_free,
                             .ctx = f};
    fos_scene_sink_t sink = {.begin = take_begin, .bytes = take_bytes, .end = take_end, .ctx = taken};
    return fos_scene_pieces_read_to((int64_t)strlen(text), 1 << 20, &io, &sink, set);
}

/* The same answer read to a sink: every scene handed over whole and in
 * order, none held, `rest` as it is from blocks. */
static void expect_to_sink(const char *text, const char *rest, int count, const char **scenes, int piece)
{
    static taken_t taken;
    taken = (taken_t){.fail_begin_at = -1, .fail_bytes_at = -1, .fail_end_at = -1};
    fos_scene_set_t set;
    fake_t f;
    fos_http_body_err_t err = read_to(text, piece, &taken, &set, &f);
    CHECK(err == FOS_HTTP_BODY_OK);
    if (err != FOS_HTTP_BODY_OK) return;
    CHECK(!taken.misuse && !taken.open);
    CHECK(taken.begun == count && taken.ended == count && set.count == count);
    CHECK(strcmp(set.rest, rest) == 0 && set.bytes == strlen(text));
    size_t at = 0;
    for (int i = 0; i < count; i++) {
        size_t len = strlen(scenes[i]);
        CHECK(set.scenes[i] == NULL && set.lens[i] == len);
        CHECK(at + len < taken.len && memcmp(taken.text + at, scenes[i], len) == 0 && taken.text[at + len] == '\n');
        at += len + 1;
    }
    CHECK(at == taken.len);
    /* Only `rest` and the read's own buffer were ever asked for. */
    CHECK(f.largest_asked <= 2048 || f.largest_asked <= 2 * (strlen(rest) + 64));
    release(&set, &f);
}

/* Every read size, so a scene, a string or an escape split across two reads
 * is read as the whole. */
static void expect(const char *text, const char *rest, int count, const char **scenes)
{
    for (int piece = 1; piece <= (int)strlen(text) + 1; piece++) expect_to_sink(text, rest, count, scenes, piece);
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
            char last[32];
            snprintf(last, sizeof(last), "{\"id\":\"s%d\"}", FOS_SCENE_PIECES_MAX - 1);
            CHECK(strcmp(set.scenes[FOS_SCENE_PIECES_MAX - 1], last) == 0);
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

    {
        /* A sink that refuses ends the read with its answer, whichever call
         * it was, and nothing of the answer is kept. */
        const char *text = "[{\"id\":\"a\"},{\"id\":\"b\"},{\"id\":\"c\"}]";
        static taken_t taken;
        fos_scene_set_t set;
        fake_t f;
        for (int piece = 1; piece <= 40; piece += 3) {
            taken = (taken_t){.fail_begin_at = 1, .fail_bytes_at = -1, .fail_end_at = -1};
            CHECK(read_to(text, piece, &taken, &set, &f) == FOS_HTTP_BODY_NO_MEMORY);
            CHECK(taken.ended == 1 && set.count == 0 && set.rest == NULL && f.live == 0);
            taken = (taken_t){.fail_begin_at = -1, .fail_bytes_at = 2, .fail_end_at = -1};
            CHECK(read_to(text, piece, &taken, &set, &f) == FOS_HTTP_BODY_READ_FAILED);
            CHECK(taken.ended == 2 && set.count == 0 && f.live == 0);
            taken = (taken_t){.fail_begin_at = -1, .fail_bytes_at = -1, .fail_end_at = 0};
            CHECK(read_to(text, piece, &taken, &set, &f) == FOS_HTTP_BODY_INVALID);
            CHECK(taken.begun == 1 && set.count == 0 && f.live == 0);
            CHECK(!taken.misuse);
        }
        /* An answer cut short part way into a scene: the sink was told of
         * what came, and the read fails. */
        taken = (taken_t){.fail_begin_at = -1, .fail_bytes_at = -1, .fail_end_at = -1};
        CHECK(read_to("[{\"id\":\"a\"},{\"id\":\"b", 5, &taken, &set, &f) == FOS_HTTP_BODY_READ_FAILED);
        CHECK(taken.begun == 2 && taken.ended == 1 && f.live == 0);
    }

    {
        /* The point of the sink: a 3 MB set of 60 KB scenes asks memory for
         * nothing but the read's buffer and `rest`. */
        size_t scene = 60 * 1024, n = 50;
        char *text = malloc(n * (scene + 1) + 3);
        size_t at = 0;
        text[at++] = '[';
        for (size_t i = 0; i < n; i++) {
            if (i) text[at++] = ',';
            memset(text + at, ' ', scene);
            text[at] = '{';
            text[at + scene - 1] = '}';
            at += scene;
        }
        text[at++] = ']';
        text[at] = '\0';
        static taken_t count_only;
        count_only = (taken_t){.fail_begin_at = -1, .fail_bytes_at = -1, .fail_end_at = -1};
        fake_t f = {.data = text, .len = at, .piece = 1460, .fail_at = -1, .largest = 4096};
        fos_http_body_io_t io = {.read = fake_read, .alloc = fake_alloc, .realloc = fake_realloc, .free = fake_free,
                                 .ctx = &f};
        /* Counted, not kept: 3 MB would not fit the test's sink either. */
        fos_scene_sink_t sink = {.begin = take_begin, .bytes = NULL, .end = take_end, .ctx = &count_only};
        sink.bytes = count_bytes;
        fos_scene_set_t set;
        CHECK(fos_scene_pieces_read_to((int64_t)at, 8 << 20, &io, &sink, &set) == FOS_HTTP_BODY_OK);
        CHECK(set.count == (int)n && count_only.begun == (int)n && count_only.ended == (int)n);
        CHECK(s_counted == n * scene);
        CHECK(f.largest_asked <= 4096);
        CHECK(strcmp(set.rest, "[]") == 0);
        fos_scene_pieces_free(&set, &io);
        CHECK(f.live == 0);
        free(text);
    }

    printf("%d checks, %d failures\n", checks, failures);
    return failures ? 1 : 0;
}

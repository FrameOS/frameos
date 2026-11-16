/* See fos_scene_pieces.h. */
#include "fos_scene_pieces.h"

#include <stdbool.h>
#include <string.h>

#define READ_CHUNK 2048
#define FIRST_PIECE 1024

typedef struct {
    const fos_http_body_io_t *io;
    fos_scene_set_t *set;
    size_t rest_cap, piece_cap;
    int depth;
    int lift;  /* the depth inside the array whose objects are scenes; 0: none open */
    int piece; /* the scene being read; -1: none */
    int key;   /* how much of "put" the key being read matched; -1: not it */
    bool in_string, escaped, object, key_put, value_put, done;
} reader_t;

static bool push(reader_t *r, char **buf, size_t *len, size_t *cap, char c)
{
    if (*len + 1 >= *cap) {
        size_t new_cap = *cap ? *cap * 2 : (buf == &r->set->rest ? 64 : FIRST_PIECE);
        char *grown = *buf ? r->io->realloc(r->io->ctx, *buf, new_cap) : r->io->alloc(r->io->ctx, new_cap);
        if (grown == NULL) return false;
        *buf = grown;
        *cap = new_cap;
    }
    (*buf)[(*len)++] = c;
    (*buf)[*len] = '\0';
    return true;
}

static fos_http_body_err_t feed(reader_t *r, char c)
{
    fos_scene_set_t *s = r->set;
    bool in_piece = r->piece >= 0;
    bool keys = !in_piece && r->object && r->depth == 1;
    if (r->in_string) {
        if (r->escaped) r->escaped = false;
        else if (c == '\\') {
            r->escaped = true;
            r->key = -1; /* an escaped key is not the plain "put" */
        } else if (c == '"') {
            r->in_string = false;
            if (keys) r->key_put = r->key == 3;
        } else if (keys && r->key >= 0) {
            r->key = r->key < 3 && c == "put"[r->key] ? r->key + 1 : -1;
        }
    } else if (r->depth == 0 && (r->done || (c != '{' && c != '['))) {
        /* Space around the one value; anything else is not a scene answer. */
        return c == ' ' || c == '\n' || c == '\r' || c == '\t' ? FOS_HTTP_BODY_OK : FOS_HTTP_BODY_INVALID;
    } else if (c == '{' || c == '[') {
        if (r->depth == 0) {
            r->object = c == '{';
        } else if (!in_piece && r->lift && r->depth == r->lift) {
            if (c != '{') return FOS_HTTP_BODY_INVALID;
            if (s->count == FOS_SCENE_PIECES_MAX) return FOS_HTTP_BODY_TOO_LARGE;
            r->piece = s->count;
            r->piece_cap = 0;
            in_piece = true;
        }
        r->depth++;
        if (in_piece) return push(r, &s->scenes[r->piece], &s->lens[r->piece], &r->piece_cap, c)
                                 ? FOS_HTTP_BODY_OK : FOS_HTTP_BODY_NO_MEMORY;
        if (!push(r, &s->rest, &s->rest_len, &r->rest_cap, c)) return FOS_HTTP_BODY_NO_MEMORY;
        /* The array whose objects are scenes: the whole answer's, or a patch's `put`. */
        if (c == '[' && (r->depth == 1 || (r->depth == 2 && r->object && r->value_put))) r->lift = r->depth;
        return FOS_HTTP_BODY_OK;
    } else if (c == '}' || c == ']') {
        if (r->depth == 0) return FOS_HTTP_BODY_INVALID;
        r->depth--;
        if (r->depth == 0) r->done = true;
        if (in_piece) {
            if (!push(r, &s->scenes[r->piece], &s->lens[r->piece], &r->piece_cap, c)) return FOS_HTTP_BODY_NO_MEMORY;
            if (r->depth == r->lift) {
                /* The scene is whole: its block shrinks to it. */
                char *fit = r->io->realloc(r->io->ctx, s->scenes[r->piece], s->lens[r->piece] + 1);
                if (fit != NULL) s->scenes[r->piece] = fit;
                s->count++;
                r->piece = -1;
            }
            return FOS_HTTP_BODY_OK;
        }
        if (r->depth + 1 == r->lift) r->lift = 0;
    } else if (r->lift && r->depth >= r->lift && !in_piece) {
        /* Between the scenes: a comma, or space. */
        return c == ',' || c == ' ' || c == '\n' || c == '\r' || c == '\t' ? FOS_HTTP_BODY_OK : FOS_HTTP_BODY_INVALID;
    } else if (c == '"') {
        r->in_string = true;
        if (keys) r->key = 0;
    } else if (keys && c == ':') {
        r->value_put = r->key_put;
    } else if (keys && c == ',') {
        r->value_put = false;
    }
    if (r->piece >= 0) return push(r, &s->scenes[r->piece], &s->lens[r->piece], &r->piece_cap, c)
                                 ? FOS_HTTP_BODY_OK : FOS_HTTP_BODY_NO_MEMORY;
    return push(r, &s->rest, &s->rest_len, &r->rest_cap, c) ? FOS_HTTP_BODY_OK : FOS_HTTP_BODY_NO_MEMORY;
}

fos_http_body_err_t fos_scene_pieces_read(int64_t content_length, size_t max_body, const fos_http_body_io_t *io,
                                          fos_scene_set_t *set)
{
    memset(set, 0, sizeof(*set));
    if (content_length > (int64_t)max_body) return FOS_HTTP_BODY_TOO_LARGE;
    char *chunk = io->alloc(io->ctx, READ_CHUNK);
    if (chunk == NULL) return FOS_HTTP_BODY_NO_MEMORY;
    reader_t r = {.io = io, .set = set, .piece = -1, .key = -1};
    fos_http_body_err_t err = FOS_HTTP_BODY_OK;
    for (;;) {
        int n = io->read(io->ctx, chunk, READ_CHUNK);
        if (n < 0) err = FOS_HTTP_BODY_READ_FAILED;
        if (n <= 0) break;
        if (set->bytes + (size_t)n > max_body) err = FOS_HTTP_BODY_TOO_LARGE;
        set->bytes += (size_t)n;
        for (int i = 0; i < n && err == FOS_HTTP_BODY_OK; i++) err = feed(&r, chunk[i]);
        if (err != FOS_HTTP_BODY_OK) break;
    }
    io->free(io->ctx, chunk);
    /* Cut short: of its declared length, or of its closing bracket. */
    if (err == FOS_HTTP_BODY_OK &&
        (!r.done || r.in_string || (content_length > 0 && set->bytes != (size_t)content_length))) {
        err = FOS_HTTP_BODY_READ_FAILED;
    }
    if (err != FOS_HTTP_BODY_OK) {
        /* A scene cut short is in its block, not yet counted. */
        if (r.piece >= 0) set->count = r.piece + 1;
        fos_scene_pieces_free(set, io);
    }
    return err;
}

void fos_scene_pieces_free(fos_scene_set_t *set, const fos_http_body_io_t *io)
{
    for (int i = 0; i < set->count; i++) io->free(io->ctx, set->scenes[i]);
    io->free(io->ctx, set->rest);
    memset(set, 0, sizeof(*set));
}

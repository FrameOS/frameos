/*
 * A backend's scene answer read in pieces: each scene object in an
 * allocation of its own, so no block the size of the set is ever needed
 * (fos_scenes_backend_fetch). A 378-415 KB set or patch did not fit a
 * reTerminal E1004 showing a photo, whose PSRAM had 1.5 MB free in blocks of
 * 300 KB (`no-memory`, the hardware bench, 2026-11-16); the largest block a
 * set needs now is its largest scene.
 *
 * The scenes lifted out are the objects of a top-level array (a whole set)
 * or of the `put` array of a top-level object (a `?patch=1` answer); what is
 * left (`[]`, or the patch with `"put":[]`) stays valid JSON in `rest`.
 * Strings, escapes and depth are tracked as fos_store_split_scenes does.
 *
 * Read to a sink (fos_scene_pieces_read_to), no scene is held at all: its
 * bytes are handed over as they come, a read's worth at a time. That is how a
 * set over what memory holds is taken (fos_scenes.c writes each scene
 * straight to the store): 529 KB did not pass the 512 KB a set held in memory
 * may be on the reTerminal Sticky, and on the E1004 a 465 KB set had no block
 * for one of its scenes (`payload-too-large`, `no-memory`: the hardware
 * bench, 2026-11-18).
 *
 * Pure C, no IDF: tests/test_fos_scene_pieces.c runs it against a fake
 * socket.
 */
#pragma once

#include <stddef.h>
#include <stdint.h>

#include "fos_http_body.h"

/* The scenes a store holds (FOS_SCENE_STORE_SCENES): more is refused, not cut. */
#define FOS_SCENE_PIECES_MAX 128

typedef struct {
    char *rest; /* NUL-terminated */
    size_t rest_len;
    int count;
    char *scenes[FOS_SCENE_PIECES_MAX]; /* each NUL-terminated, an allocation of its own */
    size_t lens[FOS_SCENE_PIECES_MAX];
    size_t bytes; /* the whole answer's */
    /* Not 0: read to a sink, which staged the scenes in the store under this
     * id (fos_scene_store_stage_open); `scenes` holds none. Set by the sink's
     * owner once the read is over: the reader knows nothing of it. */
    unsigned int staged;
} fos_scene_set_t;

/* Where the scenes of an answer go instead of into blocks: `begin` at each
 * scene's `{`, its bytes through `bytes` in as many calls as there are reads,
 * `end` after its `}`. Anything but FOS_HTTP_BODY_OK ends the read with it. */
typedef struct {
    fos_http_body_err_t (*begin)(void *ctx);
    fos_http_body_err_t (*bytes)(void *ctx, const char *bytes, size_t len);
    fos_http_body_err_t (*end)(void *ctx);
    void *ctx;
} fos_scene_sink_t;

/* Reads the answer (`content_length` as fos_http_body_read) into `set`.
 * FOS_HTTP_BODY_TOO_LARGE over `max_body` or FOS_SCENE_PIECES_MAX scenes,
 * FOS_HTTP_BODY_INVALID when it is not one array or object (a scene that is
 * not an object, text after it). On anything but OK nothing is kept. */
fos_http_body_err_t fos_scene_pieces_read(int64_t content_length, size_t max_body, const fos_http_body_io_t *io,
                                          fos_scene_set_t *set);

/* As fos_scene_pieces_read, each scene handed to `sink` as it is read and
 * none kept: `count` and `lens` say what went by, `rest` is as before. What
 * the sink took of an answer that then failed is its owner's to undo. */
fos_http_body_err_t fos_scene_pieces_read_to(int64_t content_length, size_t max_body, const fos_http_body_io_t *io,
                                             const fos_scene_sink_t *sink, fos_scene_set_t *set);

void fos_scene_pieces_free(fos_scene_set_t *set, const fos_http_body_io_t *io);

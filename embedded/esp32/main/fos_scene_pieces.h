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
 * Pure C, no IDF: tests/test_fos_scene_pieces.c runs it against a fake
 * socket.
 */
#pragma once

#include <stddef.h>
#include <stdint.h>

#include "fos_http_body.h"

/* The scene store's slots (FOS_SCENE_STORE_SLOTS): more is refused, not cut. */
#define FOS_SCENE_PIECES_MAX 32

typedef struct {
    char *rest; /* NUL-terminated */
    size_t rest_len;
    int count;
    char *scenes[FOS_SCENE_PIECES_MAX]; /* each NUL-terminated, an allocation of its own */
    size_t lens[FOS_SCENE_PIECES_MAX];
    size_t bytes; /* the whole answer's */
} fos_scene_set_t;

/* Reads the answer (`content_length` as fos_http_body_read) into `set`.
 * FOS_HTTP_BODY_TOO_LARGE over `max_body` or FOS_SCENE_PIECES_MAX scenes,
 * FOS_HTTP_BODY_INVALID when it is not one array or object (a scene that is
 * not an object, text after it). On anything but OK nothing is kept. */
fos_http_body_err_t fos_scene_pieces_read(int64_t content_length, size_t max_body, const fos_http_body_io_t *io,
                                          fos_scene_set_t *set);

void fos_scene_pieces_free(fos_scene_set_t *set, const fos_http_body_io_t *io);

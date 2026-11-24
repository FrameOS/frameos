#ifndef FOS_PARTIAL_REFRESH_H
#define FOS_PARTIAL_REFRESH_H

/*
 * Whether an e-paper panel with a partial waveform takes this picture as a
 * partial update or a full refresh (fos_display_update), and how worn the
 * glass is (docs/realtime-rendering.md "Partial refresh on e-paper").
 *
 * A partial update moves only the pixels that differ between the panel's two
 * RAM planes, with no flash, and needs the picture on the glass to be known
 * exactly. Each pixel it moves stops a little short of black or white, and
 * the next move starts from there: a pixel's error grows with the times it
 * moved, and one that never moved has none. So the ghosts are counted where
 * they are: the pixels the partial updates flipped since the last full
 * refresh, per tile of FOS_GHOST_TILE pixels a side, a tile's depth being its
 * flips over its pixels (one flip of every pixel is 1.0, a page of text
 * turned about 0.2 in the text).
 *
 * The glass is due a full refresh when a quarter of its tiles are worn
 * (FOS_GHOST_WORN deep: a book on the reTerminal Sticky every fifth page, as
 * e-readers and the panel makers' "five or six partial updates" have it) or
 * when one tile is FOS_GHOST_DEEP deep (a digit rewritten in place, some 27
 * times on the Sticky's tap counter). A new scene, a picture that mostly
 * changed and an unknown glass are full refreshes anyway.
 *
 * That refresh is seconds in which a tap goes unanswered, so while someone is
 * tapping, or pictures come quickly (fos_pictures_fast: `input_recent` says
 * either), a deep tile waits for the idle frame (fos_display_park_if_idle) up
 * to twice as deep; a worn quarter does not wait, as an e-reader's page turn
 * does not. Nothing else ever flashes the glass: no count of updates, no
 * timer on a glass with no ghosts.
 *
 * A controller that keeps the picture (the IT8951) is not counted here: it
 * settles its own ghosts (GC16 after DU) and takes a full refresh after
 * FOS_PARTIAL_MAX_BEFORE_FULL of its partial updates (FOS_PARTIAL_MAX_WHILE_INPUT
 * while someone taps).
 *
 * Pure: no IDF, so main/tests/test_fos_partial_refresh.c runs it on the host.
 */

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* A tile's side, in pixels: a few millimetres of glass, a glyph. */
#define FOS_GHOST_TILE 16
#define FOS_GHOST_TILE_PIXELS (FOS_GHOST_TILE * FOS_GHOST_TILE)
/* Depths in tenths of a flip per pixel. */
#define FOS_GHOST_WORN 10
#define FOS_GHOST_WORN_SHARE 4 /* one tile in this many is a worn glass */
#define FOS_GHOST_DEEP 160

#define FOS_PARTIAL_MAX_BEFORE_FULL 20
#define FOS_PARTIAL_MAX_WHILE_INPUT 120

/* The tiles of a 1-bit picture `row_bytes` wide and `rows` high. */
typedef struct {
    uint16_t *flips; /* per tile, row by row: pixels flipped since the last full refresh */
    size_t row_bytes;
    size_t rows;
    size_t cols;      /* tiles across */
    size_t tile_rows; /* tiles down */
} fos_ghost_t;

typedef struct {
    uint32_t deepest; /* the most worn tile's depth, tenths of a flip per pixel */
    uint32_t worn;    /* tiles FOS_GHOST_WORN deep or more */
    uint32_t tiles;
} fos_ghost_wear_t;

/* How many tiles `fos_ghost_t.flips` needs. */
size_t fos_ghost_tiles(size_t row_bytes, size_t rows);
void fos_ghost_init(fos_ghost_t *ghost, uint16_t *flips, size_t row_bytes, size_t rows);
void fos_ghost_clear(fos_ghost_t *ghost);
/* Counts what a partial update from `glass` to `next` flips; returns how many
 * bytes differ. */
size_t fos_ghost_add(fos_ghost_t *ghost, const uint8_t *glass, const uint8_t *next);
void fos_ghost_wear(const fos_ghost_t *ghost, fos_ghost_wear_t *wear);
/* Worn enough for a full refresh. */
bool fos_ghost_due(const fos_ghost_wear_t *wear);

typedef enum {
    FOS_REFRESH_PARTIAL = 0,
    FOS_REFRESH_FULL_UNSUPPORTED, /* no partial waveform, or the glass is not known */
    FOS_REFRESH_FULL_NEW_SCENE,
    FOS_REFRESH_FULL_CHANGED,     /* half the picture or more changed */
    FOS_REFRESH_FULL_GHOSTS,      /* worn (fos_ghost_due), or a controller's count ran out */
} fos_refresh_kind_t;

typedef struct {
    bool supported;    /* the panel has a partial waveform */
    bool glass_known;  /* the bytes on the glass are held in memory */
    bool same_scene;   /* the scene the last picture on the glass came from */
    bool input_recent; /* someone is tapping */
    /* With this update counted: the tiles' wear, or for a controller that
     * keeps the picture (`counted` false) its partial updates since the last
     * full refresh. */
    bool counted;
    fos_ghost_wear_t wear;
    uint32_t partials_since_full;
    size_t changed_bytes;
    size_t total_bytes;
    /* The controller keeps the picture and settles its own ghosts (the
     * IT8951): while someone taps, any change goes up as one DU, however big
     * (greys as a halftone, settled when the tapping stops), not a GC16 of the
     * whole panel that flashes for 580 ms. */
    bool controller_keeps;
} fos_partial_refresh_input_t;

fos_refresh_kind_t fos_partial_refresh_kind(const fos_partial_refresh_input_t *input);

#endif

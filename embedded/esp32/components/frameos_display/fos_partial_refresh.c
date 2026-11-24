#include "fos_partial_refresh.h"

#include <string.h>

#define TILE_BYTES (FOS_GHOST_TILE / 8)

size_t fos_ghost_tiles(size_t row_bytes, size_t rows)
{
    return ((row_bytes + TILE_BYTES - 1) / TILE_BYTES) * ((rows + FOS_GHOST_TILE - 1) / FOS_GHOST_TILE);
}

void fos_ghost_init(fos_ghost_t *ghost, uint16_t *flips, size_t row_bytes, size_t rows)
{
    ghost->flips = flips;
    ghost->row_bytes = row_bytes;
    ghost->rows = rows;
    ghost->cols = (row_bytes + TILE_BYTES - 1) / TILE_BYTES;
    ghost->tile_rows = (rows + FOS_GHOST_TILE - 1) / FOS_GHOST_TILE;
    fos_ghost_clear(ghost);
}

void fos_ghost_clear(fos_ghost_t *ghost)
{
    if (ghost->flips) memset(ghost->flips, 0, ghost->cols * ghost->tile_rows * sizeof(ghost->flips[0]));
}

size_t fos_ghost_add(fos_ghost_t *ghost, const uint8_t *glass, const uint8_t *next)
{
    size_t changed = 0;
    for (size_t y = 0; y < ghost->rows; y++) {
        const uint8_t *a = glass + y * ghost->row_bytes;
        const uint8_t *b = next + y * ghost->row_bytes;
        if (memcmp(a, b, ghost->row_bytes) == 0) continue;
        uint16_t *tiles = ghost->flips ? ghost->flips + (y / FOS_GHOST_TILE) * ghost->cols : NULL;
        for (size_t x = 0; x < ghost->row_bytes; x++) {
            unsigned moved = (unsigned)(a[x] ^ b[x]);
            if (!moved) continue;
            changed++;
            if (!tiles) continue;
            uint16_t *tile = &tiles[x / TILE_BYTES];
            unsigned flips = (unsigned)__builtin_popcount(moved);
            *tile = *tile > UINT16_MAX - flips ? UINT16_MAX : (uint16_t)(*tile + flips);
        }
    }
    return changed;
}

void fos_ghost_wear(const fos_ghost_t *ghost, fos_ghost_wear_t *wear)
{
    /* In flips: a tile's depth in tenths times its pixels. */
    const uint32_t worn_flips = FOS_GHOST_WORN * FOS_GHOST_TILE_PIXELS / 10;
    uint32_t deepest = 0;
    uint32_t worn = 0;
    size_t tiles = ghost->cols * ghost->tile_rows;
    for (size_t i = 0; ghost->flips && i < tiles; i++) {
        uint32_t flips = ghost->flips[i];
        if (flips > deepest) deepest = flips;
        if (flips >= worn_flips) worn++;
    }
    wear->deepest = deepest * 10 / FOS_GHOST_TILE_PIXELS;
    wear->worn = worn;
    wear->tiles = (uint32_t)tiles;
}

bool fos_ghost_due(const fos_ghost_wear_t *wear)
{
    return wear->deepest >= FOS_GHOST_DEEP || (wear->tiles && wear->worn * FOS_GHOST_WORN_SHARE >= wear->tiles);
}

fos_refresh_kind_t fos_partial_refresh_kind(const fos_partial_refresh_input_t *input)
{
    if (!input->supported || !input->glass_known) return FOS_REFRESH_FULL_UNSUPPORTED;
    /* A new scene starts from a clean panel, unless someone is at the frame:
     * then it is a partial update like a tap's, in half a second instead of
     * a 2.2 s flash (the reTerminal Sticky's switcher and swipes), and its
     * ghosts count like theirs. */
    if (!input->same_scene && !input->input_recent) return FOS_REFRESH_FULL_NEW_SCENE;
    if (input->changed_bytes * 2 >= input->total_bytes) return FOS_REFRESH_FULL_CHANGED;
    if (input->counted) {
        const fos_ghost_wear_t *wear = &input->wear;
        if (!input->input_recent) return fos_ghost_due(wear) ? FOS_REFRESH_FULL_GHOSTS : FOS_REFRESH_PARTIAL;
        bool worn_quarter = wear->tiles && wear->worn * FOS_GHOST_WORN_SHARE >= wear->tiles;
        return worn_quarter || wear->deepest >= 2 * FOS_GHOST_DEEP ? FOS_REFRESH_FULL_GHOSTS : FOS_REFRESH_PARTIAL;
    }
    uint32_t most = input->input_recent ? FOS_PARTIAL_MAX_WHILE_INPUT : FOS_PARTIAL_MAX_BEFORE_FULL;
    return input->partials_since_full >= most ? FOS_REFRESH_FULL_GHOSTS : FOS_REFRESH_PARTIAL;
}

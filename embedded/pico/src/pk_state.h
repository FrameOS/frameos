// Small state that has to survive a power cut and changes on every render:
// the hash of what the panel shows (so an identical frame skips a 25-second
// refresh — and on an Inky Frame every wake is a cold boot, so RAM cannot
// remember it) and the render counter.
//
// Rewriting one flash sector per render would wear it out in under a year at
// a 5-minute interval (100k cycles), so records are APPENDED: a 4 KB sector
// holds 128 of them and is erased only when full, which is ~12.8 M renders.
// NOR flash programs bits 1→0 only, so an append re-programs the 256-byte
// page with the earlier records unchanged and the new one in erased space.
//
// Portable: the flash is three injected operations. Host-tested against a
// NOR model that refuses 0→1 (tests/test_pk_state.c).
#ifndef PK_STATE_H
#define PK_STATE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define PK_STATE_SECTOR_SIZE 4096u
#define PK_STATE_PAGE_SIZE 256u
#define PK_STATE_HASH_LEN 16

typedef struct {
    uint8_t display_hash[PK_STATE_HASH_LEN]; // of the last payload the panel refreshed to
    uint32_t render_count;                   // panel refreshes since the sector was first used
    uint8_t has_display;                     // 0 until the panel has been refreshed once
    uint8_t shows_scene;                     // the refresh was a rendered frame, not a status screen
} pk_state_t;

typedef struct {
    void *ctx;
    void (*read)(void *ctx, uint32_t offset, uint8_t *dst, size_t len);
    void (*erase_sector)(void *ctx);
    // `data` is one whole page; offset is a multiple of PK_STATE_PAGE_SIZE.
    void (*program_page)(void *ctx, uint32_t offset, const uint8_t *data);
} pk_state_flash_t;

// The newest valid record, or zeroes (returns false) when there is none.
bool pk_state_load(const pk_state_flash_t *flash, pk_state_t *out);
// Appends; erases first when the sector is full or holds anything unreadable.
void pk_state_save(const pk_state_flash_t *flash, const pk_state_t *state);

#endif // PK_STATE_H

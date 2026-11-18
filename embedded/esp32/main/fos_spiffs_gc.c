/*
 * Room on a SPIFFS partition before a write: blocks that hold nothing but
 * deleted pages are erased first.
 *
 * esp_spiffs_gc() hands its work to SPIFFS_gc(), which the linker routes
 * here (-Wl,--wrap=SPIFFS_gc, main/CMakeLists.txt). SPIFFS's own collector
 * picks its block by erase age before garbage (50 points for each erase
 * since the block's last one, 5 for each deleted page): it cleans the block
 * erased longest ago, whatever is in it. On a partition with photos written
 * once, those are the photos' blocks, 14 live pages and 1 deleted each, so
 * every collection moves 14 pages to free 1. On the SenseCAP Indicator's
 * 1 MB /state four esp_spiffs_gc calls (40 blocks) did not free 24 KB for a
 * scene while 57 blocks held only deleted pages, and the write failed
 * (2026-10-26).
 *
 * Such a block is erased without moving anything, until the write fits with
 * its own blocks free on top of the 3 SPIFFS keeps (with 3 or fewer free it
 * collects again inside the write, the old way), or until there are none;
 * then SPIFFS's collection gets what is left. Blocks with live data in them
 * are cleaned only by that collection now, so they take fewer of the erases:
 * the price of not moving a photo to free one page.
 *
 * The blocks are found in one walk of the partition, which goes on from where
 * the last one stopped. SPIFFS_gc_quick, which this used to call once a
 * block, starts at block 0 every time and reads a whole lookup page per block
 * on its way: on the 32 MB boards' 24 MB /state (6144 blocks) making room
 * for a 529 KB scene set took 48 of the 71 seconds it took to store (the
 * reTerminal Sticky, 2026-11-18: 324 blocks erased, 147 ms each where the
 * erase itself is a third of that). A walk reads each block's lookup entries
 * alone, straight off flash (the lookup is never held back in SPIFFS's write
 * cache), and lets the lock go after each erase and every few hundred blocks,
 * so a reader is kept waiting for one erase at most. Going on from where it
 * stopped also spreads the erases: block 0's side of the partition no longer
 * takes them all.
 *
 * Host test: main/tests/test_fos_spiffs_gc.c, run against ESP-IDF's SPIFFS
 * sources by backend/app/tasks/tests/test_esp32_spiffs_gc.py.
 */
#include <stdbool.h>

#include "spiffs.h"
#include "spiffs_nucleus.h"

s32_t __real_SPIFFS_gc(spiffs *fs, u32_t size);
s32_t __wrap_SPIFFS_gc(spiffs *fs, u32_t size);

/* What spiffs_gc_check() wants before it lets a write of `size` bytes go
 * without collecting, plus the write's own blocks. */
static bool write_fits(spiffs *fs, u32_t size)
{
    const u32_t pages_per_block = SPIFFS_PAGES_PER_BLOCK(fs) - SPIFFS_OBJ_LOOKUP_PAGES(fs);
    const u32_t block_bytes = pages_per_block * SPIFFS_DATA_PAGE_SIZE(fs);
    SPIFFS_LOCK(fs);
    const s32_t free_pages = (s32_t)(pages_per_block * (fs->block_count - 2)) -
                             (s32_t)fs->stats_p_allocated - (s32_t)fs->stats_p_deleted;
    const bool fits = fs->free_blocks > 3 + (size + block_bytes - 1) / block_bytes &&
                      (s32_t)size < free_pages * (s32_t)SPIFFS_DATA_PAGE_SIZE(fs);
    SPIFFS_UNLOCK(fs);
    return fits;
}

/* Whether every page of the block is a deleted one, by its lookup entries. */
static bool only_deleted_pages(spiffs *fs, spiffs_block_ix bix)
{
    spiffs_obj_id entries[32];
    u32_t left = SPIFFS_PAGES_PER_BLOCK(fs) - SPIFFS_OBJ_LOOKUP_PAGES(fs);
    u32_t addr = SPIFFS_BLOCK_TO_PADDR(fs, bix);
    while (left > 0) {
        u32_t count = left < 32 ? left : 32;
        if (SPIFFS_HAL_READ(fs, addr, count * sizeof(spiffs_obj_id), (u8_t *)entries) != SPIFFS_OK) return false;
        for (u32_t i = 0; i < count; i++) {
            if (entries[i] != SPIFFS_OBJ_ID_DELETED) return false;
        }
        addr += count * sizeof(spiffs_obj_id);
        left -= count;
    }
    return true;
}

/* As spiffs_gc_quick leaves a block it erased. */
static void erase_deleted_block(spiffs *fs, spiffs_block_ix bix)
{
    fs->stats_p_deleted -= SPIFFS_PAGES_PER_BLOCK(fs) - SPIFFS_OBJ_LOOKUP_PAGES(fs);
    spiffs_erase_block(fs, bix);
#if SPIFFS_CACHE
    for (u32_t i = 0; i < SPIFFS_PAGES_PER_BLOCK(fs); i++) {
        spiffs_cache_drop_page(fs, SPIFFS_PAGE_FOR_BLOCK(fs, bix) + i);
    }
#endif
}

/* Blocks read in one hold of the lock, when none of them is erased. */
#define WALK_BLOCKS_A_HOLD 256

/* Where the last walk stopped. One file system in the firmware (/state); the
 * host test mounts several in turn, and each starts at its block 0. */
static spiffs *s_walk_fs = NULL;
static spiffs_block_ix s_walk_block = 0;

/* Blocks holding only deleted pages, erased until a write of `size` fits or
 * every block has been looked at once. */
static void erase_deleted_blocks(spiffs *fs, u32_t size)
{
    if (s_walk_fs != fs || s_walk_block >= fs->block_count) {
        s_walk_fs = fs;
        s_walk_block = 0;
    }
    u32_t left = fs->block_count;
    while (left > 0 && !write_fits(fs, size)) {
        SPIFFS_LOCK(fs);
        for (u32_t held = 0; left > 0 && held < WALK_BLOCKS_A_HOLD; held++) {
            spiffs_block_ix bix = s_walk_block;
            s_walk_block = (spiffs_block_ix)((s_walk_block + 1) % fs->block_count);
            left--;
            if (only_deleted_pages(fs, bix)) {
                erase_deleted_block(fs, bix);
                break; /* the lock goes, and the write may fit now */
            }
        }
        SPIFFS_UNLOCK(fs);
    }
}

s32_t __wrap_SPIFFS_gc(spiffs *fs, u32_t size)
{
    if (SPIFFS_mounted(fs)) erase_deleted_blocks(fs, size);
    return __real_SPIFFS_gc(fs, size);
}

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
 * SPIFFS_gc_quick erases one such block without moving anything. It runs
 * until the write fits with its own blocks free on top of the 3 SPIFFS
 * keeps (with 3 or fewer free it collects again inside the write, the old
 * way), or until there are none; then SPIFFS's collection gets what is
 * left. Blocks with live data in them are cleaned only by that collection
 * now, so they take fewer of the erases: the price of not moving a photo to
 * free one page.
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

s32_t __wrap_SPIFFS_gc(spiffs *fs, u32_t size)
{
    if (SPIFFS_mounted(fs)) {
        while (!write_fits(fs, size) && SPIFFS_gc_quick(fs, 0) == SPIFFS_OK) {
        }
        /* The last call says there was nothing left to erase. */
        SPIFFS_clearerr(fs);
    }
    return __real_SPIFFS_gc(fs, size);
}

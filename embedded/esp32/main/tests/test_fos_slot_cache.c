/* Host test of fos_slot_cache.c: the scene files fos_scenes.c read last,
 * kept in memory so a scene shown before is not looked up on flash again.
 * What must hold: a write of the scene files is never answered from before
 * it (the clear, and the generation a racing read carries), and the cache
 * stays inside its eight entries and 256 KB, the least recently used going
 * first.
 *
 *   cc -std=c11 -Wall -Wextra -Werror -O2 -Imain \
 *      main/fos_slot_cache.c main/tests/test_fos_slot_cache.c -o t && ./t
 *
 * Run by backend/app/tasks/tests/test_esp32_slot_cache.py.
 */
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "fos_slot_cache.h"

static int checks = 0;
static int failures = 0;

#define CHECK(cond)                                                              \
    do {                                                                         \
        checks++;                                                                \
        if (!(cond)) {                                                           \
            failures++;                                                          \
            printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);               \
        }                                                                        \
    } while (0)

/* A malloc'd file body of `len` bytes, every byte `fill`. */
static char *body(size_t len, char fill)
{
    char *json = malloc(len + 1);
    memset(json, fill, len);
    json[len] = 0;
    return json;
}

static bool holds(fos_slot_cache_t *cache, int slot, char fill, size_t len)
{
    size_t got = 0;
    const char *json = fos_slot_cache_find(cache, slot, &got);
    if (json == NULL || got != len) return false;
    for (size_t i = 0; i < len; i++) {
        if (json[i] != fill) return false;
    }
    return true;
}

static void test_a_scene_read_once_comes_back(void)
{
    fos_slot_cache_t cache = {0};
    CHECK(fos_slot_cache_find(&cache, 3, NULL) == NULL);
    uint32_t generation = fos_slot_cache_generation(&cache);
    CHECK(fos_slot_cache_keep(&cache, 3, body(100, 'a'), 100, generation));
    CHECK(holds(&cache, 3, 'a', 100));
    CHECK(fos_slot_cache_find(&cache, 4, NULL) == NULL);
    /* The same slot read again by a second reader that also missed: one copy. */
    CHECK(fos_slot_cache_keep(&cache, 3, body(120, 'b'), 120, generation));
    CHECK(fos_slot_cache_count(&cache) == 1);
    CHECK(holds(&cache, 3, 'b', 120));
    fos_slot_cache_clear(&cache);
}

static void test_a_write_is_never_answered_from_before_it(void)
{
    fos_slot_cache_t cache = {0};
    uint32_t generation = fos_slot_cache_generation(&cache);
    CHECK(fos_slot_cache_keep(&cache, 1, body(10, 'o'), 10, generation));
    /* The scene files are written: what was held goes. */
    fos_slot_cache_clear(&cache);
    CHECK(fos_slot_cache_find(&cache, 1, NULL) == NULL);
    CHECK(fos_slot_cache_count(&cache) == 0);
    /* A read that began before the write (it noted the old generation) and
     * finished after it holds the old bytes: they do not go in. */
    CHECK(!fos_slot_cache_keep(&cache, 1, body(10, 'o'), 10, generation));
    CHECK(fos_slot_cache_find(&cache, 1, NULL) == NULL);
    /* A read after the write does. */
    CHECK(fos_slot_cache_keep(&cache, 1, body(10, 'n'), 10, fos_slot_cache_generation(&cache)));
    CHECK(holds(&cache, 1, 'n', 10));
    fos_slot_cache_clear(&cache);
}

static void test_big_files_are_not_kept(void)
{
    fos_slot_cache_t cache = {0};
    const size_t half = FOS_SLOT_CACHE_MAX_BYTES / 2;
    CHECK(!fos_slot_cache_wants(0));
    CHECK(fos_slot_cache_wants(half));
    CHECK(!fos_slot_cache_wants(half + 1));
    uint32_t generation = fos_slot_cache_generation(&cache);
    CHECK(!fos_slot_cache_keep(&cache, 2, body(half + 1, 'x'), half + 1, generation));
    CHECK(fos_slot_cache_count(&cache) == 0);
    CHECK(fos_slot_cache_keep(&cache, 2, body(half, 'x'), half, generation));
    CHECK(fos_slot_cache_bytes(&cache) == half);
    /* NULL is nothing to keep, and nothing breaks. */
    CHECK(!fos_slot_cache_keep(&cache, 5, NULL, 10, generation));
    fos_slot_cache_clear(&cache);
}

static void test_eight_entries_the_least_recently_used_goes(void)
{
    fos_slot_cache_t cache = {0};
    uint32_t generation = fos_slot_cache_generation(&cache);
    for (int slot = 0; slot < FOS_SLOT_CACHE_ENTRIES; slot++) {
        CHECK(fos_slot_cache_keep(&cache, slot, body(64, (char)('a' + slot)), 64, generation));
    }
    CHECK(fos_slot_cache_count(&cache) == FOS_SLOT_CACHE_ENTRIES);
    /* Slot 0 is shown again: slot 1 is now the one used longest ago. */
    CHECK(holds(&cache, 0, 'a', 64));
    CHECK(fos_slot_cache_keep(&cache, 100, body(64, 'z'), 64, generation));
    CHECK(fos_slot_cache_count(&cache) == FOS_SLOT_CACHE_ENTRIES);
    CHECK(fos_slot_cache_find(&cache, 1, NULL) == NULL);
    CHECK(holds(&cache, 0, 'a', 64));
    CHECK(holds(&cache, 100, 'z', 64));
    for (int slot = 2; slot < FOS_SLOT_CACHE_ENTRIES; slot++) {
        CHECK(holds(&cache, slot, (char)('a' + slot), 64));
    }
    fos_slot_cache_clear(&cache);
}

static void test_256_kb_the_least_recently_used_goes(void)
{
    fos_slot_cache_t cache = {0};
    uint32_t generation = fos_slot_cache_generation(&cache);
    const size_t big = 100u * 1024u;
    CHECK(fos_slot_cache_keep(&cache, 1, body(big, '1'), big, generation));
    CHECK(fos_slot_cache_keep(&cache, 2, body(big, '2'), big, generation));
    CHECK(holds(&cache, 1, '1', big)); /* 2 is now the older */
    /* A third 100 KB would make 300 KB: 2 goes, 1 and 3 stay. */
    CHECK(fos_slot_cache_keep(&cache, 3, body(big, '3'), big, generation));
    CHECK(fos_slot_cache_bytes(&cache) <= FOS_SLOT_CACHE_MAX_BYTES);
    CHECK(fos_slot_cache_find(&cache, 2, NULL) == NULL);
    CHECK(holds(&cache, 1, '1', big));
    CHECK(holds(&cache, 3, '3', big));
    /* A 128 KB file in a cache of small ones: as many go as it takes. */
    fos_slot_cache_clear(&cache);
    generation = fos_slot_cache_generation(&cache);
    for (int slot = 0; slot < 6; slot++) {
        CHECK(fos_slot_cache_keep(&cache, slot, body(40u * 1024u, 's'), 40u * 1024u, generation));
    }
    const size_t half = FOS_SLOT_CACHE_MAX_BYTES / 2;
    CHECK(fos_slot_cache_keep(&cache, 9, body(half, 'h'), half, generation));
    CHECK(fos_slot_cache_bytes(&cache) <= FOS_SLOT_CACHE_MAX_BYTES);
    CHECK(holds(&cache, 9, 'h', half));
    CHECK(fos_slot_cache_find(&cache, 0, NULL) == NULL); /* the oldest went first */
    CHECK(fos_slot_cache_find(&cache, 5, NULL) != NULL); /* the newest stayed */
    fos_slot_cache_clear(&cache);
}

static void test_a_scene_walk_reads_flash_once_per_scene(void)
{
    /* What the cache is for: walking through five scenes and back, each scene
     * is read from flash once. A stand-in for read_slot_file. */
    fos_slot_cache_t cache = {0};
    int flash_reads = 0;
    const int walk[] = {0, 1, 2, 3, 4, 0, 1, 2, 3, 4, 2, 2, 0};
    for (size_t i = 0; i < sizeof(walk) / sizeof(walk[0]); i++) {
        int slot = walk[i];
        uint32_t generation = fos_slot_cache_generation(&cache);
        if (fos_slot_cache_find(&cache, slot, NULL) != NULL) continue;
        flash_reads++;
        fos_slot_cache_keep(&cache, slot, body(2000, (char)('0' + slot)), 2000, generation);
    }
    CHECK(flash_reads == 5);
    /* A push of new scenes in the middle: each is read again, once. */
    fos_slot_cache_clear(&cache);
    for (size_t i = 0; i < sizeof(walk) / sizeof(walk[0]); i++) {
        int slot = walk[i];
        uint32_t generation = fos_slot_cache_generation(&cache);
        if (fos_slot_cache_find(&cache, slot, NULL) != NULL) continue;
        flash_reads++;
        fos_slot_cache_keep(&cache, slot, body(2000, (char)('0' + slot)), 2000, generation);
    }
    CHECK(flash_reads == 10);
    fos_slot_cache_clear(&cache);
}

int main(void)
{
    test_a_scene_read_once_comes_back();
    test_a_write_is_never_answered_from_before_it();
    test_big_files_are_not_kept();
    test_eight_entries_the_least_recently_used_goes();
    test_256_kb_the_least_recently_used_goes();
    test_a_scene_walk_reads_flash_once_per_scene();
    printf("%d checks, %d failures\n", checks, failures);
    return failures == 0 ? 0 : 1;
}

/*
 * Host test for fos_spiffs_gc.c, run against ESP-IDF's own SPIFFS sources
 * on a 1 MB partition in RAM laid out like the SenseCAP Indicator's /state
 * (256-byte pages, 4 KB blocks, the firmware's SPIFFS settings in
 * spiffs_shim/sdkconfig.h).
 *
 * Build and run (from embedded/esp32/, with an ESP-IDF checkout):
 *
 *   S=$IDF_PATH/components/spiffs
 *   cc -std=c11 -O2 -Imain -Imain/tests/spiffs_shim -I$S/include \
 *      -I$S/spiffs/src -D__real_SPIFFS_gc=SPIFFS_gc \
 *      main/fos_spiffs_gc.c main/tests/test_fos_spiffs_gc.c \
 *      $S/spiffs/src/spiffs_*.c -o /tmp/test_fos_spiffs_gc \
 *      && /tmp/test_fos_spiffs_gc
 *
 * (backend/app/tasks/tests/test_esp32_spiffs_gc.py does that in CI when it
 * finds ESP-IDF.) The firmware's linker sends SPIFFS_gc to the wrapper;
 * macOS's has no --wrap, so here the wrapper's __real_SPIFFS_gc is
 * SPIFFS_gc itself and the test calls the wrapper where esp_spiffs_gc would.
 *
 * The workload is the bench board's: five photos written once, then scene
 * uploads the way fos_scenes.c stores them (the combined payload, then one
 * file per scene, each through a temporary name and a rename, room asked
 * for first as make_room does) with scene state written in between. The
 * same workload runs twice from the same image, with SPIFFS's collector
 * and with the wrapper.
 */
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "fos_spiffs_footprint.h"
#include "spiffs.h"
#include "spiffs_nucleus.h"

s32_t __wrap_SPIFFS_gc(spiffs *fs, u32_t size);

static int g_failures = 0;
static int g_checks = 0;

#define CHECK(cond, ...)                                                       \
    do {                                                                       \
        g_checks++;                                                            \
        if (!(cond)) {                                                         \
            g_failures++;                                                      \
            printf("FAIL %s:%d: ", __func__, __LINE__);                        \
            printf(__VA_ARGS__);                                               \
            printf("\n");                                                      \
        }                                                                      \
    } while (0)

void spiffs_api_lock(struct spiffs_t *fs) { (void)fs; }
void spiffs_api_unlock(struct spiffs_t *fs) { (void)fs; }

#define FLASH_SIZE (1024 * 1024)
#define BLOCK_SIZE 4096
#define PAGE_SIZE 256
#define BLOCKS (FLASH_SIZE / BLOCK_SIZE)

static u8_t g_flash[FLASH_SIZE];
static long g_block_erases[BLOCKS];

static s32_t hal_read(struct spiffs_t *fs, u32_t addr, u32_t size, u8_t *dst)
{
    (void)fs;
    memcpy(dst, g_flash + addr, size);
    return SPIFFS_OK;
}

/* NOR flash: a write only clears bits. */
static s32_t hal_write(struct spiffs_t *fs, u32_t addr, u32_t size, u8_t *src)
{
    (void)fs;
    for (u32_t i = 0; i < size; i++) g_flash[addr + i] &= src[i];
    return SPIFFS_OK;
}

static s32_t hal_erase(struct spiffs_t *fs, u32_t addr, u32_t size)
{
    (void)fs;
    memset(g_flash + addr, 0xff, size);
    g_block_erases[addr / BLOCK_SIZE]++;
    return SPIFFS_OK;
}

static spiffs g_fs;
static u8_t g_work[2 * PAGE_SIZE];
static u8_t g_fds[8 * sizeof(spiffs_fd)];
static u8_t g_cache[sizeof(spiffs_cache) + 8 * (sizeof(spiffs_cache_page) + PAGE_SIZE)];

static bool mount(void)
{
    spiffs_config cfg = {0};
    cfg.phys_size = FLASH_SIZE;
    cfg.phys_addr = 0;
    cfg.phys_erase_block = BLOCK_SIZE;
    cfg.log_block_size = BLOCK_SIZE;
    cfg.log_page_size = PAGE_SIZE;
    cfg.hal_read_f = hal_read;
    cfg.hal_write_f = hal_write;
    cfg.hal_erase_f = hal_erase;
    return SPIFFS_mount(&g_fs, &cfg, g_work, g_fds, sizeof(g_fds), g_cache, sizeof(g_cache),
                        NULL) == SPIFFS_OK;
}

typedef s32_t (*gc_fn)(spiffs *fs, u32_t size);

/* fos_scenes.c: room first (esp_spiffs_gc for the payload and 4 KB, up to
 * four times), then the payload to a temporary name, the old file out, and
 * the rename. esp_spiffs's open stamps the mtime, so that is here too. */
static bool write_file(gc_fn gc, const char *path, const char *tmp, const u8_t *data, size_t len)
{
    SPIFFS_remove(&g_fs, tmp);
    SPIFFS_clearerr(&g_fs);
    for (int round = 0; round < 4; round++) {
        if (gc(&g_fs, (u32_t)len + 4096) == SPIFFS_OK) break;
        SPIFFS_clearerr(&g_fs);
    }
    spiffs_file f = SPIFFS_open(&g_fs, tmp, SPIFFS_O_CREAT | SPIFFS_O_TRUNC | SPIFFS_O_WRONLY, 0);
    if (f < 0) {
        SPIFFS_clearerr(&g_fs);
        return false;
    }
    u8_t meta[SPIFFS_OBJ_META_LEN] = {1, 2, 3, 4};
    SPIFFS_fupdate_meta(&g_fs, f, meta);
    bool ok = true;
    for (size_t done = 0; ok && done < len;) {
        size_t chunk = len - done > 2048 ? 2048 : len - done;
        ok = SPIFFS_write(&g_fs, f, (void *)(data + done), (s32_t)chunk) == (s32_t)chunk;
        done += chunk;
    }
    SPIFFS_close(&g_fs, f);
    if (!ok) {
        SPIFFS_clearerr(&g_fs);
        SPIFFS_remove(&g_fs, tmp);
        SPIFFS_clearerr(&g_fs);
        return false;
    }
    SPIFFS_remove(&g_fs, path);
    SPIFFS_clearerr(&g_fs);
    if (SPIFFS_rename(&g_fs, tmp, path) != SPIFFS_OK) {
        SPIFFS_clearerr(&g_fs);
        return false;
    }
    return true;
}

/* The bench board's photos and scenes, in bytes (2026-10-26). */
static const size_t PHOTOS[] = {60587, 113163, 112775, 74953, 99664};
static const size_t SLOTS[] = {5020, 4408, 3212, 6050, 3529, 2861, 3472,
                               2972, 4533, 3803, 4664, 23974, 5741};
#define SLOT_COUNT (sizeof(SLOTS) / sizeof(SLOTS[0]))

static u8_t g_data[128 * 1024];

static void fresh_image_with_photos(void)
{
    memset(g_flash, 0xff, sizeof(g_flash));
    CHECK(!mount(), "a blank partition is not a file system yet");
    SPIFFS_clearerr(&g_fs);
    CHECK(SPIFFS_format(&g_fs) == SPIFFS_OK, "format");
    CHECK(mount(), "mount after format");
    for (size_t i = 0; i < sizeof(PHOTOS) / sizeof(PHOTOS[0]); i++) {
        char path[32];
        snprintf(path, sizeof(path), "/a/photos/p%zu.jpg", i);
        CHECK(write_file(SPIFFS_gc, path, "/a/.u", g_data, PHOTOS[i]), "photo %zu", i);
    }
    SPIFFS_unmount(&g_fs);
}

typedef struct {
    int failed_writes;
    long erases;
    long most_erases_on_one_block;
} run_result;

static run_result run_uploads(gc_fn gc, const u8_t *image, int uploads)
{
    memcpy(g_flash, image, sizeof(g_flash));
    memset(g_block_erases, 0, sizeof(g_block_erases));
    run_result result = {0};
    CHECK(mount(), "mount the photo image");
    size_t payload = 0;
    for (size_t i = 0; i < SLOT_COUNT; i++) payload += SLOTS[i];
    for (int upload = 0; upload < uploads; upload++) {
        if (!write_file(gc, "/scenes.json", "/scenes.json.tmp", g_data, payload)) {
            result.failed_writes++;
            continue;
        }
        for (size_t i = 0; i < SLOT_COUNT; i++) {
            char path[32];
            snprintf(path, sizeof(path), "/scene-%zu.json", i);
            if (!write_file(gc, path, "/scene-slot.tmp", g_data, SLOTS[i])) result.failed_writes++;
        }
        if (!write_file(gc, "/scene-index.json", "/scene-index.tmp", g_data, 730)) result.failed_writes++;
        SPIFFS_remove(&g_fs, "/scenes.json");
        SPIFFS_clearerr(&g_fs);
        for (int i = 0; i < 60; i++) {
            char path[32];
            snprintf(path, sizeof(path), "/st-%08x.json", i % 3);
            if (!write_file(gc, path, "/st.tmp", g_data, 40)) result.failed_writes++;
        }
    }
    SPIFFS_unmount(&g_fs);
    for (int b = 0; b < BLOCKS; b++) {
        result.erases += g_block_erases[b];
        if (g_block_erases[b] > result.most_erases_on_one_block) {
            result.most_erases_on_one_block = g_block_erases[b];
        }
    }
    return result;
}

static u8_t g_image[FLASH_SIZE];

static void test_scene_uploads_beside_photos(void)
{
    for (size_t i = 0; i < sizeof(g_data); i++) g_data[i] = (u8_t)(i * 31 + 7);
    fresh_image_with_photos();
    memcpy(g_image, g_flash, sizeof(g_image));

    const int uploads = 30;
    run_result stock = run_uploads(SPIFFS_gc, g_image, uploads);
    run_result wrapped = run_uploads(__wrap_SPIFFS_gc, g_image, uploads);
    printf("  SPIFFS's collector: %d failed writes, %ld erases, at most %ld on one block\n",
           stock.failed_writes, stock.erases, stock.most_erases_on_one_block);
    printf("  deleted blocks first: %d failed writes, %ld erases, at most %ld on one block\n",
           wrapped.failed_writes, wrapped.erases, wrapped.most_erases_on_one_block);
    /* The workload has to show the failure, or the next check proves nothing. */
    CHECK(stock.failed_writes > 0,
          "SPIFFS's collector no longer fails this workload: revisit fos_spiffs_gc.c");
    CHECK(wrapped.failed_writes == 0, "%d writes failed with deleted blocks erased first",
          wrapped.failed_writes);
    CHECK(wrapped.erases < stock.erases, "erases: %ld, SPIFFS alone %ld", wrapped.erases,
          stock.erases);
}

/* The reTerminal E1002's 20-scene set (2026-11-10): eleven slot sizes read off
 * the board, the other nine sharing what is left of the 389,616-byte push. */
static const size_t E1002_SCENES[] = {7682, 8218, 7007, 15370, 88903, 26641, 73893,
                                      40478, 35217, 1346, 12268, 8063, 8063, 8063,
                                      8063, 8063, 8063, 8063, 8063, 8068};
#define E1002_COUNT (sizeof(E1002_SCENES) / sizeof(E1002_SCENES[0]))
static u8_t g_big[400 * 1024];

static void remove_slots(void)
{
    for (int i = 0; i < 32; i++) {
        char path[32];
        snprintf(path, sizeof(path), "/scene-%d.json", i);
        if (SPIFFS_remove(&g_fs, path) != SPIFFS_OK) {
            SPIFFS_clearerr(&g_fs);
            break;
        }
    }
}

/* fos_scenes.c split_scenes: one file per scene through a temporary name,
 * the index, then the combined file goes. False on the first write that
 * fails (the store then removes every slot and loads the payload whole). */
static bool split(bool old_slots_first)
{
    if (old_slots_first) remove_slots();
    for (size_t i = 0; i < E1002_COUNT; i++) {
        char path[32];
        snprintf(path, sizeof(path), "/scene-%zu.json", i);
        if (!write_file(__wrap_SPIFFS_gc, path, "/scene-slot.tmp", g_big, E1002_SCENES[i])) {
            remove_slots();
            return false;
        }
    }
    bool ok = write_file(__wrap_SPIFFS_gc, "/scene-index.json", "/scene-index.tmp", g_big, 2400);
    SPIFFS_remove(&g_fs, "/scenes.json");
    SPIFFS_clearerr(&g_fs);
    return ok;
}

/* A set close to half the partition, pushed again over itself. The combined
 * payload is stored beside the set on flash (the old set stays until the new
 * one is whole), and the split then held the combined file, the new slots
 * and the old ones not yet replaced: out of room at the fifth scene, every
 * time, and the frame loaded the payload whole instead. The old slots are
 * redundant once the combined file is on flash: removed before the split,
 * the same push splits. */
static void test_a_big_set_pushed_over_itself_splits(void)
{
    for (size_t i = 0; i < sizeof(g_big); i++) g_big[i] = (u8_t)(i * 13 + 5);
    size_t payload = 21; /* the brackets and the commas */
    for (size_t i = 0; i < E1002_COUNT; i++) payload += E1002_SCENES[i];
    CHECK(payload == 389616, "the E1002's push was 389,616 bytes, this is %zu", payload);

    memset(g_flash, 0xff, sizeof(g_flash));
    CHECK(!mount(), "a blank partition is not a file system yet");
    SPIFFS_clearerr(&g_fs);
    CHECK(SPIFFS_format(&g_fs) == SPIFFS_OK, "format");
    CHECK(mount(), "mount after format");
    CHECK(write_file(__wrap_SPIFFS_gc, "/tz.json", "/tz.tmp", g_big, 1432), "tz.json");
    CHECK(write_file(__wrap_SPIFFS_gc, "/scenes.json", "/scenes.json.tmp", g_big, payload),
          "the first push fits an empty partition");
    CHECK(split(true), "and splits");
    /* The same set again, over the one on flash. */
    CHECK(write_file(__wrap_SPIFFS_gc, "/scenes.json", "/scenes.json.tmp", g_big, payload),
          "the push is stored beside the set");
    SPIFFS_unmount(&g_fs);
    memcpy(g_image, g_flash, sizeof(g_image));

    CHECK(mount(), "mount");
    /* The workload has to show the failure, or the next check proves nothing. */
    CHECK(!split(false), "in place, the split now fits: revisit split_scenes");
    SPIFFS_unmount(&g_fs);

    memcpy(g_flash, g_image, sizeof(g_flash));
    CHECK(mount(), "mount");
    CHECK(split(true), "with the old slots removed first, the push splits");
    spiffs_stat st;
    CHECK(SPIFFS_stat(&g_fs, "/scene-19.json", &st) == SPIFFS_OK && st.size == E1002_SCENES[19],
          "the last scene is whole");
    SPIFFS_clearerr(&g_fs);
    CHECK(SPIFFS_stat(&g_fs, "/scenes.json", &st) != SPIFFS_OK, "and the combined file is gone");
    SPIFFS_clearerr(&g_fs);
    SPIFFS_unmount(&g_fs);
}

/* Room already there: nothing is erased. */
static void test_nothing_erased_when_the_write_fits(void)
{
    fresh_image_with_photos();
    memset(g_block_erases, 0, sizeof(g_block_erases));
    CHECK(mount(), "mount");
    CHECK(__wrap_SPIFFS_gc(&g_fs, 30 * 1024) == SPIFFS_OK, "30 KB fits");
    long erases = 0;
    for (int b = 0; b < BLOCKS; b++) erases += g_block_erases[b];
    CHECK(erases == 0, "%ld blocks erased with the room already there", erases);
    SPIFFS_unmount(&g_fs);
}

/* More than the partition holds: SPIFFS's answer comes back. */
static void test_too_big_is_still_full(void)
{
    fresh_image_with_photos();
    CHECK(mount(), "mount");
    CHECK(__wrap_SPIFFS_gc(&g_fs, FLASH_SIZE) == SPIFFS_ERR_FULL, "1 MB does not fit in 1 MB");
    SPIFFS_clearerr(&g_fs);
    SPIFFS_unmount(&g_fs);
}

/* fos_spiffs_footprint.c, against this SPIFFS: what each file adds to the
 * partition's own `used`, at both page sizes the firmware uses (256 on the
 * 8 MB layout's 1 MB /state, 512 on the 32 MB one's). */
#define FOOTPRINT_MAX_PAGE 512
static u8_t g_fp_work[2 * FOOTPRINT_MAX_PAGE];
static u8_t g_fp_fds[4 * sizeof(spiffs_fd)];
static u8_t g_fp_cache[sizeof(spiffs_cache) + 4 * (sizeof(spiffs_cache_page) + FOOTPRINT_MAX_PAGE)];

static void footprint_at(u32_t page)
{
    static const size_t sizes[] = {0, 1, 250, 251, 252, 502, 503, 1000, 5000, 25000, 25853, 25854,
                                   26000, 60000, 59000, 117000, 120000, 200000};
    memset(g_flash, 0xff, sizeof(g_flash));
    spiffs fs;
    spiffs_config cfg = {0};
    cfg.phys_size = FLASH_SIZE;
    cfg.phys_erase_block = BLOCK_SIZE;
    cfg.log_block_size = BLOCK_SIZE;
    cfg.log_page_size = page;
    cfg.hal_read_f = hal_read;
    cfg.hal_write_f = hal_write;
    cfg.hal_erase_f = hal_erase;
    SPIFFS_mount(&fs, &cfg, g_fp_work, g_fp_fds, sizeof(g_fp_fds), g_fp_cache, sizeof(g_fp_cache), NULL);
    SPIFFS_unmount(&fs);
    CHECK(SPIFFS_format(&fs) == SPIFFS_OK, "format at %u", (unsigned)page);
    CHECK(SPIFFS_mount(&fs, &cfg, g_fp_work, g_fp_fds, sizeof(g_fp_fds), g_fp_cache, sizeof(g_fp_cache),
                       NULL) == SPIFFS_OK, "mount at %u", (unsigned)page);
    static u8_t body[200000];
    memset(body, 'x', sizeof(body));
    for (size_t i = 0; i < sizeof(sizes) / sizeof(sizes[0]); i++) {
        char name[32];
        snprintf(name, sizeof(name), "scene-%u.json", (unsigned)i);
        u32_t total = 0, before = 0, after = 0;
        SPIFFS_info(&fs, &total, &before);
        spiffs_file f = SPIFFS_open(&fs, name, SPIFFS_O_CREAT | SPIFFS_O_TRUNC | SPIFFS_O_WRONLY, 0);
        CHECK(f >= 0, "open %s", name);
        for (size_t done = 0; done < sizes[i];) {
            size_t chunk = sizes[i] - done > 2048 ? 2048 : sizes[i] - done;
            SPIFFS_write(&fs, f, body + done, (s32_t)chunk);
            done += chunk;
        }
        SPIFFS_close(&fs, f);
        SPIFFS_info(&fs, &total, &after);
        size_t expected = fos_spiffs_footprint(sizes[i], page, SPIFFS_OBJ_NAME_LEN, SPIFFS_OBJ_META_LEN);
        CHECK(after - before == expected, "%u-byte file at %u-byte pages: SPIFFS used +%u, footprint %u",
              (unsigned)sizes[i], (unsigned)page, (unsigned)(after - before), (unsigned)expected);
        SPIFFS_remove(&fs, name);
    }
    SPIFFS_unmount(&fs);
}

static void test_footprint_is_what_spiffs_counts(void)
{
    footprint_at(256);
    footprint_at(512);
}

int main(void)
{
    test_nothing_erased_when_the_write_fits();
    test_too_big_is_still_full();
    test_scene_uploads_beside_photos();
    test_a_big_set_pushed_over_itself_splits();
    test_footprint_is_what_spiffs_counts();
    printf("%d checks, %d failures\n", g_checks, g_failures);
    return g_failures == 0 ? 0 : 1;
}

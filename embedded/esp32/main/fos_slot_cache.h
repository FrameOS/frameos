#pragma once

/* The scene files read last, as they are on flash (fos_scenes.c
 * read_slot_file). Opening a SPIFFS file walks the partition until it finds
 * it, up to 0.7 s on the reTerminal E1003's 24 MB, and every scene switch
 * read its scene that way (2026-11-10): a scene shown before comes from here.
 *
 * No locking and no IDF: the caller holds its own lock around every call and
 * does the reading and the copying outside it. Any write of the scene files
 * clears the cache, and a read that raced one does not go in: the caller
 * notes the generation before it reads the file and hands it to
 * fos_slot_cache_keep. Host-tested (main/tests/test_fos_slot_cache.c). */

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define FOS_SLOT_CACHE_ENTRIES 8
#define FOS_SLOT_CACHE_MAX_BYTES (256u * 1024u)

typedef struct {
    int slot;
    char *json; /* NULL: the entry is free */
    size_t len;
    uint32_t used;
} fos_slot_cache_entry_t;

typedef struct {
    fos_slot_cache_entry_t entries[FOS_SLOT_CACHE_ENTRIES];
    uint32_t generation;
    uint32_t clock;
} fos_slot_cache_t;

/* The generation a read starts from. */
uint32_t fos_slot_cache_generation(const fos_slot_cache_t *cache);

/* The bytes held for `slot` (NULL when none), still owned by the cache: copy
 * them under the lock. Counts as a use. */
const char *fos_slot_cache_find(fos_slot_cache_t *cache, int slot, size_t *out_len);

/* Whether a file of `len` bytes is worth keeping: at most half the budget. */
bool fos_slot_cache_wants(size_t len);

/* Takes `json` (malloc'd, `len` bytes) for `slot`, read from a file when the
 * generation was `read_generation`. Always takes ownership: freed at once
 * when the files were written since, when it is too big, or when it replaces
 * an older copy of the same slot. Makes room by bytes and by entries, the
 * least recently used going first. True when kept. */
bool fos_slot_cache_keep(fos_slot_cache_t *cache, int slot, char *json, size_t len, uint32_t read_generation);

/* Everything dropped, and reads begun before this cannot go in. */
void fos_slot_cache_clear(fos_slot_cache_t *cache);

/* What the cache holds now, in bytes and entries (for tests and logs). */
size_t fos_slot_cache_bytes(const fos_slot_cache_t *cache);
int fos_slot_cache_count(const fos_slot_cache_t *cache);

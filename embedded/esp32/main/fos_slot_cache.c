#include "fos_slot_cache.h"

#include <stdlib.h>

uint32_t fos_slot_cache_generation(const fos_slot_cache_t *cache)
{
    return cache->generation;
}

const char *fos_slot_cache_find(fos_slot_cache_t *cache, int slot, size_t *out_len)
{
    for (int i = 0; i < FOS_SLOT_CACHE_ENTRIES; i++) {
        fos_slot_cache_entry_t *entry = &cache->entries[i];
        if (entry->json != NULL && entry->slot == slot) {
            entry->used = ++cache->clock;
            if (out_len != NULL) *out_len = entry->len;
            return entry->json;
        }
    }
    return NULL;
}

bool fos_slot_cache_wants(size_t len)
{
    return len > 0 && len <= FOS_SLOT_CACHE_MAX_BYTES / 2;
}

static void drop(fos_slot_cache_entry_t *entry)
{
    free(entry->json);
    *entry = (fos_slot_cache_entry_t){0};
}

bool fos_slot_cache_keep(fos_slot_cache_t *cache, int slot, char *json, size_t len, uint32_t read_generation)
{
    if (json == NULL) return false;
    if (read_generation != cache->generation || !fos_slot_cache_wants(len)) {
        /* The scenes were written while this one was read, or it is too big. */
        free(json);
        return false;
    }
    /* Two readers that both missed: the later copy replaces the earlier. */
    for (int i = 0; i < FOS_SLOT_CACHE_ENTRIES; i++) {
        if (cache->entries[i].json != NULL && cache->entries[i].slot == slot) drop(&cache->entries[i]);
    }
    size_t total = len;
    int free_at = -1;
    for (int i = 0; i < FOS_SLOT_CACHE_ENTRIES; i++) {
        if (cache->entries[i].json == NULL) {
            if (free_at < 0) free_at = i;
        } else {
            total += cache->entries[i].len;
        }
    }
    /* Room by bytes and by entries, the least recently used going first. */
    while (total > FOS_SLOT_CACHE_MAX_BYTES || free_at < 0) {
        int oldest = -1;
        for (int i = 0; i < FOS_SLOT_CACHE_ENTRIES; i++) {
            if (cache->entries[i].json != NULL &&
                (oldest < 0 || cache->entries[i].used < cache->entries[oldest].used)) {
                oldest = i;
            }
        }
        if (oldest < 0) break;
        total -= cache->entries[oldest].len;
        drop(&cache->entries[oldest]);
        free_at = oldest;
    }
    cache->entries[free_at] = (fos_slot_cache_entry_t){.slot = slot, .json = json, .len = len, .used = ++cache->clock};
    return true;
}

void fos_slot_cache_clear(fos_slot_cache_t *cache)
{
    for (int i = 0; i < FOS_SLOT_CACHE_ENTRIES; i++) drop(&cache->entries[i]);
    cache->generation++;
}

size_t fos_slot_cache_bytes(const fos_slot_cache_t *cache)
{
    size_t total = 0;
    for (int i = 0; i < FOS_SLOT_CACHE_ENTRIES; i++) {
        if (cache->entries[i].json != NULL) total += cache->entries[i].len;
    }
    return total;
}

int fos_slot_cache_count(const fos_slot_cache_t *cache)
{
    int count = 0;
    for (int i = 0; i < FOS_SLOT_CACHE_ENTRIES; i++) {
        if (cache->entries[i].json != NULL) count++;
    }
    return count;
}

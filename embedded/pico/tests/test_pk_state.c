// The render-state append log against a NOR flash model that behaves like
// the real part: programming can only clear bits, and only erase sets them.
#include <stdlib.h>

#include "pk_state.h"
#include "pk_test.h"

typedef struct {
    uint8_t cells[PK_STATE_SECTOR_SIZE];
    int erases;
    int programs;
    int illegal_programs; // a program that needed a 0 -> 1 transition
} nor_t;

static void nor_read(void *ctx, uint32_t offset, uint8_t *dst, size_t len)
{
    nor_t *nor = ctx;
    memcpy(dst, nor->cells + offset, len);
}

static void nor_erase(void *ctx)
{
    nor_t *nor = ctx;
    memset(nor->cells, 0xFF, sizeof(nor->cells));
    nor->erases++;
}

static void nor_program(void *ctx, uint32_t offset, const uint8_t *data)
{
    nor_t *nor = ctx;
    nor->programs++;
    if (offset % PK_STATE_PAGE_SIZE != 0 || offset + PK_STATE_PAGE_SIZE > PK_STATE_SECTOR_SIZE) {
        nor->illegal_programs++;
        return;
    }
    for (size_t i = 0; i < PK_STATE_PAGE_SIZE; i++) {
        if ((nor->cells[offset + i] & data[i]) != data[i]) nor->illegal_programs++;
        nor->cells[offset + i] &= data[i];
    }
}

static pk_state_t state_for(uint32_t n)
{
    pk_state_t state;
    memset(&state, 0, sizeof(state));
    for (int i = 0; i < PK_STATE_HASH_LEN; i++) state.display_hash[i] = (uint8_t)(n * 31u + (uint32_t)i);
    state.render_count = n;
    state.has_display = 1;
    state.shows_scene = (uint8_t)(n & 1u);
    return state;
}

static bool same(const pk_state_t *a, const pk_state_t *b)
{
    return memcmp(a->display_hash, b->display_hash, PK_STATE_HASH_LEN) == 0 &&
           a->render_count == b->render_count && a->has_display == b->has_display &&
           a->shows_scene == b->shows_scene;
}

int main(void)
{
    nor_t *nor = calloc(1, sizeof(nor_t));
    pk_state_flash_t flash = {nor, nor_read, nor_erase, nor_program};
    pk_state_t loaded;

    // Factory-fresh (erased) and garbage (never erased) flash both read as
    // "nothing shown yet".
    memset(nor->cells, 0xFF, sizeof(nor->cells));
    CHECK(!pk_state_load(&flash, &loaded) && loaded.has_display == 0 && loaded.render_count == 0);
    memset(nor->cells, 0x5A, sizeof(nor->cells));
    CHECK(!pk_state_load(&flash, &loaded));

    // First save over garbage erases once, then appends.
    pk_state_t first = state_for(1);
    pk_state_save(&flash, &first);
    CHECK(nor->erases == 1);
    CHECK(pk_state_load(&flash, &loaded) && same(&loaded, &first));

    // A year of renders: every save reads back, the sector is erased once per
    // 128 records, and no program ever asks NOR for a 0 -> 1.
    int erases_before = nor->erases;
    for (uint32_t n = 2; n <= 1000; n++) {
        pk_state_t next = state_for(n);
        pk_state_save(&flash, &next);
        if (!pk_state_load(&flash, &loaded) || !same(&loaded, &next)) {
            fprintf(stderr, "lost record %u\n", (unsigned)n);
            CHECK(false);
            break;
        }
    }
    CHECK(nor->illegal_programs == 0);
    CHECK(nor->erases - erases_before == 999 / 128); // 7
    CHECK(nor->programs == 1000);

    // Power cut mid-append: a half-written record is skipped, the previous
    // one still loads, and the next save lands after the torn slot.
    memset(nor->cells, 0xFF, sizeof(nor->cells));
    pk_state_t good = state_for(7);
    pk_state_save(&flash, &good);
    memset(nor->cells + 32, 0x00, 11); // slot 1: torn
    CHECK(pk_state_load(&flash, &loaded) && same(&loaded, &good));
    pk_state_t after = state_for(8);
    pk_state_save(&flash, &after);
    CHECK(pk_state_load(&flash, &loaded) && same(&loaded, &after));
    CHECK(nor->illegal_programs == 0);
    CHECK(nor->cells[32] == 0x00 && nor->cells[64] != 0xFF); // torn slot untouched, new one in slot 2

    // A flipped bit in the newest record falls back to the one before it.
    nor->cells[64 + 6] ^= 0x01;
    CHECK(pk_state_load(&flash, &loaded) && same(&loaded, &good));

    free(nor);
    return pk_test_result("test_pk_state");
}

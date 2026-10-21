#include "pk_state.h"

#include <string.h>

#define RECORD_MAGIC 0x31534B50u // "PKS1"
#define RECORD_SIZE 32u
#define RECORD_COUNT (PK_STATE_SECTOR_SIZE / RECORD_SIZE)

typedef struct {
    uint32_t magic;
    uint8_t display_hash[PK_STATE_HASH_LEN];
    uint32_t render_count;
    uint32_t flags; // bit 0: has_display, bit 1: shows_scene
    uint32_t crc;   // over everything before it
} pk_state_record_t;

_Static_assert(sizeof(pk_state_record_t) == RECORD_SIZE, "state record must stay 32 bytes");

static uint32_t crc32_of(const void *data, size_t len)
{
    const uint8_t *bytes = data;
    uint32_t crc = 0xFFFFFFFFu;
    for (size_t i = 0; i < len; i++) {
        crc ^= bytes[i];
        for (int bit = 0; bit < 8; bit++) {
            crc = (crc >> 1) ^ (0xEDB88320u & (0u - (crc & 1u)));
        }
    }
    return ~crc;
}

static bool record_valid(const pk_state_record_t *record)
{
    return record->magic == RECORD_MAGIC &&
           record->crc == crc32_of(record, offsetof(pk_state_record_t, crc));
}

static bool record_erased(const pk_state_record_t *record)
{
    const uint8_t *bytes = (const uint8_t *)record;
    for (size_t i = 0; i < RECORD_SIZE; i++) {
        if (bytes[i] != 0xFF) return false;
    }
    return true;
}

// Index of the newest valid record (-1: none) and of the first erased slot
// (RECORD_COUNT: the sector is full).
static void scan(const pk_state_flash_t *flash, int *newest, uint32_t *free_slot,
                 pk_state_record_t *newest_record)
{
    *newest = -1;
    *free_slot = RECORD_COUNT;
    for (uint32_t i = 0; i < RECORD_COUNT; i++) {
        pk_state_record_t record;
        flash->read(flash->ctx, i * RECORD_SIZE, (uint8_t *)&record, RECORD_SIZE);
        if (record_erased(&record)) {
            // Appends are sequential, so the first erased slot ends the log.
            *free_slot = i;
            return;
        }
        if (record_valid(&record)) {
            *newest = (int)i;
            if (newest_record) *newest_record = record;
        }
        // Anything else is a torn write: skipped, never reused until erase.
    }
}

bool pk_state_load(const pk_state_flash_t *flash, pk_state_t *out)
{
    memset(out, 0, sizeof(*out));
    int newest;
    uint32_t free_slot;
    pk_state_record_t record;
    scan(flash, &newest, &free_slot, &record);
    if (newest < 0) return false;
    memcpy(out->display_hash, record.display_hash, PK_STATE_HASH_LEN);
    out->render_count = record.render_count;
    out->has_display = (uint8_t)(record.flags & 1u);
    out->shows_scene = (uint8_t)((record.flags >> 1) & 1u);
    return true;
}

void pk_state_save(const pk_state_flash_t *flash, const pk_state_t *state)
{
    int newest;
    uint32_t free_slot;
    scan(flash, &newest, &free_slot, NULL);
    if (free_slot >= RECORD_COUNT) {
        flash->erase_sector(flash->ctx);
        free_slot = 0;
    }

    pk_state_record_t record;
    memset(&record, 0, sizeof(record));
    record.magic = RECORD_MAGIC;
    memcpy(record.display_hash, state->display_hash, PK_STATE_HASH_LEN);
    record.render_count = state->render_count;
    record.flags = (state->has_display ? 1u : 0u) | (state->shows_scene ? 2u : 0u);
    record.crc = crc32_of(&record, offsetof(pk_state_record_t, crc));

    uint32_t record_offset = free_slot * RECORD_SIZE;
    uint32_t page_offset = record_offset - (record_offset % PK_STATE_PAGE_SIZE);
    uint8_t page[PK_STATE_PAGE_SIZE];
    flash->read(flash->ctx, page_offset, page, sizeof(page));
    memcpy(page + (record_offset - page_offset), &record, RECORD_SIZE);
    flash->program_page(flash->ctx, page_offset, page);
}

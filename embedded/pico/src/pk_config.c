#include "pk_config.h"

#include <string.h>

#include "hardware/flash.h"
#include "hardware/sync.h"
#include "pico/stdlib.h"

// Last 4KB sector of flash. PICO_FLASH_SIZE_BYTES comes from the board
// definition (2MB pico_w, 4MB pico2_w), so the firmware and its config
// stay consistent per target without a linker-script partition table.
#define PK_CONFIG_FLASH_OFFSET (PICO_FLASH_SIZE_BYTES - FLASH_SECTOR_SIZE)
#define PK_CONFIG_MAGIC 0x504B4346u // "PKCF"
#define PK_CONFIG_VERSION 1u

typedef struct {
    uint32_t magic;
    uint32_t version;
    pk_config_t config;
    uint32_t crc;
} pk_config_blob_t;

static pk_config_t s_config;

static uint32_t crc32_of(const void *data, size_t len)
{
    // Small bitwise CRC32 (poly 0xEDB88320); config writes are rare and the
    // blob is a few hundred bytes, speed is irrelevant.
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

static void set_defaults(pk_config_t *config)
{
    memset(config, 0, sizeof(*config));
    config->frame_id = 0;
    config->interval_seconds = 300;
    pk_pins_t unset = {-1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1};
    config->pins = unset;
}

pk_config_t *pk_config(void)
{
    return &s_config;
}

void pk_config_load(void)
{
    const pk_config_blob_t *blob =
        (const pk_config_blob_t *)(XIP_BASE + PK_CONFIG_FLASH_OFFSET);
    set_defaults(&s_config);
    if (blob->magic != PK_CONFIG_MAGIC || blob->version != PK_CONFIG_VERSION) {
        return;
    }
    if (crc32_of(&blob->config, sizeof(blob->config)) != blob->crc) {
        return;
    }
    s_config = blob->config;
    if (s_config.interval_seconds < 15) {
        s_config.interval_seconds = 15;
    }
}

bool pk_config_save(void)
{
    static_assert(sizeof(pk_config_blob_t) <= FLASH_SECTOR_SIZE, "config blob too large");
    // Flash programming needs page-aligned, page-multiple writes.
    static uint8_t page_buffer[((sizeof(pk_config_blob_t) + FLASH_PAGE_SIZE - 1) /
                                FLASH_PAGE_SIZE) * FLASH_PAGE_SIZE];
    pk_config_blob_t blob = {
        .magic = PK_CONFIG_MAGIC,
        .version = PK_CONFIG_VERSION,
        .config = s_config,
        .crc = crc32_of(&s_config, sizeof(s_config)),
    };
    memset(page_buffer, 0xFF, sizeof(page_buffer));
    memcpy(page_buffer, &blob, sizeof(blob));

    // Flash writes stall XIP: disable interrupts for the erase+program pair.
    // The CYW43 driver tolerates the short outage (poll architecture).
    uint32_t interrupts = save_and_disable_interrupts();
    flash_range_erase(PK_CONFIG_FLASH_OFFSET, FLASH_SECTOR_SIZE);
    flash_range_program(PK_CONFIG_FLASH_OFFSET, page_buffer, sizeof(page_buffer));
    restore_interrupts(interrupts);
    return true;
}

void pk_config_factory_reset(void)
{
    uint32_t interrupts = save_and_disable_interrupts();
    flash_range_erase(PK_CONFIG_FLASH_OFFSET, FLASH_SECTOR_SIZE);
    restore_interrupts(interrupts);
    set_defaults(&s_config);
}

bool pk_config_wifi_ready(void)
{
    return s_config.wifi_ssid[0] != '\0';
}

bool pk_config_backend_ready(void)
{
    return s_config.backend_url[0] != '\0' && s_config.frame_id != 0 &&
           s_config.api_key[0] != '\0';
}

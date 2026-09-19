#include "pk_config.h"

#include <stddef.h>
#include <string.h>

#include "hardware/flash.h"
#include "hardware/sync.h"
#include "pico/stdlib.h"

#include "pk_flash_layout.h"

#define PK_CONFIG_MAGIC 0x504B4346u // "PKCF"
#define PK_CONFIG_VERSION 3u        // v2: + deep_sleep; v3: + everything after it
#define PK_CONFIG_VERSION_2 2u

typedef struct {
    uint32_t magic;
    uint32_t version;
    pk_config_t config;
    uint32_t crc;
} pk_config_blob_t;

// The v2 layout, kept so a board provisioned by the first Pico firmware
// keeps its Wi-Fi and backend through the update. It is a strict prefix of
// today's struct.
typedef struct {
    char wifi_ssid[PK_STR_LEN];
    char wifi_pass[PK_STR_LEN];
    char backend_url[PK_URL_LEN];
    char api_key[PK_STR_LEN];
    uint32_t frame_id;
    char panel[PK_STR_LEN];
    char hardware_preset[PK_STR_LEN];
    pk_pins_t pins;
    uint32_t interval_seconds;
    uint8_t deep_sleep;
} pk_config_v2_t;

typedef struct {
    uint32_t magic;
    uint32_t version;
    pk_config_v2_t config;
    uint32_t crc;
} pk_config_blob_v2_t;

static pk_config_t s_config;

static uint32_t crc32_of(const void *data, size_t len)
{
    // Small bitwise CRC32 (poly 0xEDB88320); config writes are rare and the
    // blob is under a kilobyte, speed is irrelevant.
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

pk_config_t *pk_config(void)
{
    return &s_config;
}

static void terminate_strings(pk_config_t *config)
{
    // Whatever flash held, every string the firmware reads ends.
    config->wifi_ssid[sizeof(config->wifi_ssid) - 1] = '\0';
    config->wifi_pass[sizeof(config->wifi_pass) - 1] = '\0';
    config->backend_url[sizeof(config->backend_url) - 1] = '\0';
    config->api_key[sizeof(config->api_key) - 1] = '\0';
    config->panel[sizeof(config->panel) - 1] = '\0';
    config->hardware_preset[sizeof(config->hardware_preset) - 1] = '\0';
    config->hostname[sizeof(config->hostname) - 1] = '\0';
    config->name[sizeof(config->name) - 1] = '\0';
    config->admin_user[sizeof(config->admin_user) - 1] = '\0';
    config->admin_pass[sizeof(config->admin_pass) - 1] = '\0';
    config->ap_psk[sizeof(config->ap_psk) - 1] = '\0';
}

void pk_config_load(void)
{
    const uint8_t *flash = (const uint8_t *)(XIP_BASE + PK_FLASH_CONFIG_OFFSET);
    const pk_config_blob_t *blob = (const pk_config_blob_t *)flash;
    pk_config_defaults(&s_config);
    if (blob->magic != PK_CONFIG_MAGIC) return;

    if (blob->version == PK_CONFIG_VERSION) {
        if (crc32_of(&blob->config, sizeof(blob->config)) != blob->crc) return;
        s_config = blob->config;
    } else if (blob->version == PK_CONFIG_VERSION_2) {
        const pk_config_blob_v2_t *old = (const pk_config_blob_v2_t *)flash;
        if (crc32_of(&old->config, sizeof(old->config)) != old->crc) return;
        // Defaults for everything v2 did not have, then the old fields over them.
        memcpy(&s_config, &old->config, offsetof(pk_config_v2_t, deep_sleep) + 1);
    } else {
        return;
    }
    terminate_strings(&s_config);
    if (s_config.interval_seconds < PK_INTERVAL_MIN_SECONDS) {
        s_config.interval_seconds = PK_INTERVAL_MIN_SECONDS;
    }
}

bool pk_config_save(void)
{
    static_assert(sizeof(pk_config_blob_t) <= FLASH_SECTOR_SIZE, "config blob too large");
    static_assert(offsetof(pk_config_v2_t, deep_sleep) == offsetof(pk_config_t, deep_sleep),
                  "v2 config must stay a prefix of the current one");
    // Flash programming needs page-aligned, page-multiple writes.
    static uint8_t page_buffer[((sizeof(pk_config_blob_t) + FLASH_PAGE_SIZE - 1) /
                                FLASH_PAGE_SIZE) * FLASH_PAGE_SIZE];
    const pk_config_blob_t *current = (const pk_config_blob_t *)(XIP_BASE + PK_FLASH_CONFIG_OFFSET);
    if (current->magic == PK_CONFIG_MAGIC && current->version == PK_CONFIG_VERSION &&
        memcmp(&current->config, &s_config, sizeof(s_config)) == 0) {
        return true; // nothing changed: spare the erase cycle
    }

    memset(page_buffer, 0xFF, sizeof(page_buffer));
    pk_config_blob_t *blob = (pk_config_blob_t *)page_buffer;
    blob->magic = PK_CONFIG_MAGIC;
    blob->version = PK_CONFIG_VERSION;
    blob->config = s_config;
    blob->crc = crc32_of(&s_config, sizeof(s_config));

    // Flash writes stall XIP: disable interrupts for the erase+program pair.
    // The CYW43 driver tolerates the short outage (poll architecture).
    uint32_t interrupts = save_and_disable_interrupts();
    flash_range_erase(PK_FLASH_CONFIG_OFFSET, FLASH_SECTOR_SIZE);
    flash_range_program(PK_FLASH_CONFIG_OFFSET, page_buffer, sizeof(page_buffer));
    restore_interrupts(interrupts);

    current = (const pk_config_blob_t *)(XIP_BASE + PK_FLASH_CONFIG_OFFSET);
    return memcmp(current, page_buffer, sizeof(pk_config_blob_t)) == 0;
}

void pk_config_factory_reset(void)
{
    uint32_t interrupts = save_and_disable_interrupts();
    flash_range_erase(PK_FLASH_CONFIG_OFFSET, FLASH_SECTOR_SIZE);
    flash_range_erase(PK_FLASH_STATE_OFFSET, FLASH_SECTOR_SIZE);
    restore_interrupts(interrupts);
    pk_config_defaults(&s_config);
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

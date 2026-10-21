// Persistent configuration for the FrameOS Pico thin client.
//
// One fixed-size struct in the last 4KB flash sector — the Pico has no NVS,
// and a versioned struct with a CRC is enough for two dozen settings. A
// factory reset erases the sector; an unreadable or mismatched blob falls
// back to defaults (unprovisioned). The struct itself and everything that
// edits it (pk_config_keys.c) is portable; only pk_config.c touches flash.
#ifndef PK_CONFIG_H
#define PK_CONFIG_H

#include <stdbool.h>
#include <stdint.h>

#define PK_STR_LEN 96
#define PK_URL_LEN 160
#define PK_NAME_LEN 64

#define PK_INTERVAL_MIN_SECONDS 15
#define PK_INTERVAL_DEFAULT_SECONDS 300

typedef struct {
    int8_t sck;
    int8_t mosi;
    int8_t cs;
    int8_t dc;
    int8_t rst;
    // BUSY is either a plain GPIO (busy >= 0, sr_clock < 0) or a bit read
    // through the Inky Frame's shift register (sr_* >= 0, busy_bit set).
    int8_t busy;
    int8_t sr_clock;
    int8_t sr_latch;
    int8_t sr_data;
    int8_t busy_bit;
    // Inky Frame power latch (HOLD_VSYS_EN, GP2): on battery the regulator
    // only stays up while this pin is driven high — it must be asserted
    // first thing at boot, before WiFi or the display.
    int8_t hold_vsys;
} pk_pins_t;

typedef struct {
    char wifi_ssid[PK_STR_LEN];
    char wifi_pass[PK_STR_LEN];
    char backend_url[PK_URL_LEN];
    char api_key[PK_STR_LEN];
    uint32_t frame_id;
    char panel[PK_STR_LEN];       // FrameOS panel key, e.g. "EPD_5in65f"
    char hardware_preset[PK_STR_LEN];
    pk_pins_t pins;
    uint32_t interval_seconds;    // render poll interval (min 15s)
    // Battery mode: after each render, power off via the RTC + HOLD_VSYS
    // latch and cold-boot on the next interval (Inky Frame ~20uA).
    uint8_t deep_sleep;
    // --- v3 ---
    // Same power-cut, but only while no USB power is present (VBUS sense).
    uint8_t deep_sleep_on_battery;
    uint8_t send_logs;            // upload the log ring to the backend
    uint8_t admin_auth;           // HTTP Basic login for the device's own pages
    uint8_t debug;
    uint8_t reserved[3];
    char hostname[PK_NAME_LEN];   // DHCP + mDNS name ("frame42" → frame42.local)
    char name[PK_NAME_LEN];       // display name, from the settings pull
    char admin_user[PK_NAME_LEN];
    char admin_pass[PK_STR_LEN];
    char ap_psk[PK_NAME_LEN];     // setup hotspot passphrase, minted on first use
} pk_config_t;

pk_config_t *pk_config(void);
void pk_config_defaults(pk_config_t *config);
void pk_config_load(void);
bool pk_config_save(void);
void pk_config_factory_reset(void);
bool pk_config_wifi_ready(void);
bool pk_config_backend_ready(void);

#endif // PK_CONFIG_H

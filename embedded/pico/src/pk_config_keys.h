// `set <key> <value>`: every way a config value gets written — the USB
// console, the browser's `usb_api set`, the setup portal form — goes through
// pk_config_set(), so the three agree on keys, validation and side effects.
//
// The key vocabulary is the ESP32 console's (embedded/esp32/main/fos_console.c
// cmd_set): the backend emits one provisioning plan for every embedded board
// (backend/app/tasks/embedded_firmware.py `embedded_provisioning_plan`), so a
// key that only means something on a board with an on-device renderer is
// accepted and reported as ignored rather than failing the whole plan.
//
// Portable, host-tested (tests/test_pk_config_keys.c).
#ifndef PK_CONFIG_KEYS_H
#define PK_CONFIG_KEYS_H

#include <stdbool.h>
#include <stddef.h>

#include "pk_config.h"

typedef enum {
    PK_SET_OK = 0,
    PK_SET_IGNORED,     // a valid FrameOS key this firmware has no use for
    PK_SET_UNKNOWN_KEY,
    PK_SET_INVALID,     // known key, refused value; message says why
} pk_set_result_t;

// Says whether a panel key has a driver in this image.
typedef bool (*pk_panel_known_fn)(const char *panel);

typedef struct {
    const char *name;
    const char *panel;
    pk_pins_t pins;
} pk_preset_t;

const pk_preset_t *pk_config_presets(size_t *count);
const pk_preset_t *pk_config_find_preset(const char *name);

// Applies one key. `message` always receives a short human-readable outcome.
pk_set_result_t pk_config_set(pk_config_t *config, const char *key, const char *value,
                              pk_panel_known_fn panel_known, char *message, size_t message_cap);

// "sck=18,mosi=19,…": only the keys present change. ESP32-only keys (cs2,
// pwr) are accepted and dropped.
bool pk_config_parse_pins(const char *spec, pk_pins_t *pins);
// The same spec, for `status`.
void pk_config_format_pins(const pk_pins_t *pins, char *dst, size_t cap);

bool pk_config_url_is_supported(const char *url);
// Lowercase letters, digits and inner dashes, at most 63: a DNS label.
bool pk_config_hostname_is_valid(const char *hostname);

#endif // PK_CONFIG_KEYS_H

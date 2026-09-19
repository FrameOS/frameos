// The settings pull, parsed: GET {backend}/api/frames/{id}/embedded/settings
// returns {"frame": {...}, "schedule": …, <service settings>} (producer:
// backend/app/api/embedded_device.py `embedded_frame_settings`; ESP32
// consumer: embedded/esp32/main/fos_settings.c). A thin client reads the few
// `frame` keys that mean something without an on-device renderer — the rest
// (rotation, time zone, scaling, the schedule, service settings) is applied
// where the scene actually runs, on the control plane.
//
// Portable, host-tested (tests/test_pk_settings_parse.c).
#ifndef PK_SETTINGS_PARSE_H
#define PK_SETTINGS_PARSE_H

#include <stddef.h>

#include "pk_config.h"

#define PK_SETTINGS_CHANGED_INTERVAL (1u << 0)
#define PK_SETTINGS_CHANGED_NAME (1u << 1)
#define PK_SETTINGS_CHANGED_DEEP_SLEEP (1u << 2)
#define PK_SETTINGS_CHANGED_ADMIN_AUTH (1u << 3)
// The document had no readable "frame" object; nothing was touched.
#define PK_SETTINGS_INVALID (1u << 31)

// Applies the document to `config` and returns what changed. `summary`
// receives a one-line description of the changes for the log ("interval
// 300→900, deepSleep on"), secrets never included; empty when nothing did.
unsigned pk_settings_apply(const char *json, size_t len, pk_config_t *config,
                           char *summary, size_t summary_cap);

#endif // PK_SETTINGS_PARSE_H

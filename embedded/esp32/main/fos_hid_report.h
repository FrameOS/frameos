#pragma once

/* The pure half of the Bluetooth keyboard and mouse (fos_bt.c): what a HID
 * device's report descriptor says its input reports hold, the decode of one
 * report against it, and a keyboard report's change as key edges. No IDF:
 * host-tested by tests/test_fos_hid_report.c.
 *
 * A HID-over-GATT device sends each input report on its own characteristic
 * without the report id byte (the id is the characteristic's Report
 * Reference), so every offset here is from the report's first data bit. */

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define FOS_HID_REPORTS_MAX 8
/* The keys a report can hold down at once that we keep (a boot keyboard
 * says six; an NKRO bitmap may say more, the rest are dropped). */
#define FOS_HID_KEYS_MAX 10

typedef enum {
    FOS_HID_KIND_NONE = 0,
    FOS_HID_KIND_KEYBOARD = 1,
    FOS_HID_KIND_MOUSE = 2,
} fos_hid_kind_t;

typedef struct {
    uint16_t bit;  /* first bit of the field */
    uint8_t size;  /* bits; 0 when the report has no such field */
} fos_hid_field_t;

typedef struct {
    uint8_t id;          /* report id, 0 for a descriptor without ids */
    uint8_t kind;        /* fos_hid_kind_t */
    uint16_t bits;       /* the input report's length in bits */
    /* A keyboard: the modifier byte (usages 0xE0..0xE7, one bit each), the
     * array of keys held (usage numbers, `keys_count` of `keys_size` bits),
     * and/or a bitmap of keys (NKRO: one bit per usage from `map_min`). */
    fos_hid_field_t mods;
    fos_hid_field_t keys;
    uint8_t keys_count;
    fos_hid_field_t map;
    uint8_t map_min;
    /* A mouse: the buttons (one bit each), the motion and the wheels, each
     * signed. */
    fos_hid_field_t buttons;
    fos_hid_field_t x, y, wheel, pan;
} fos_hid_report_t;

typedef struct {
    fos_hid_report_t reports[FOS_HID_REPORTS_MAX];
    uint8_t count;
} fos_hid_map_t;

typedef struct {
    uint8_t mods;                     /* bit i: usage 0xE0 + i */
    uint8_t keys[FOS_HID_KEYS_MAX];   /* usages held, 0 for none */
    uint8_t count;
} fos_hid_keys_t;

typedef struct {
    uint8_t buttons;                  /* bit i: button i (0 left, 1 right, 2 middle) */
    int16_t dx, dy, wheel, pan;
} fos_hid_mouse_t;

/* The input reports of a report descriptor that are a keyboard or a mouse.
 * Returns how many; a descriptor it cannot read gives 0. */
int fos_hid_parse_map(const uint8_t *desc, size_t len, fos_hid_map_t *out);

/* The report of `map` with this id, or NULL. */
const fos_hid_report_t *fos_hid_find(const fos_hid_map_t *map, uint8_t id);

/* The boot protocol's reports (HID 1.11 appendix B), for a device without a
 * usable descriptor: an 8-byte keyboard report, a 3-byte mouse report with an
 * optional fourth byte for the wheel. */
void fos_hid_boot_keyboard(fos_hid_report_t *out);
void fos_hid_boot_mouse(fos_hid_report_t *out);

/* One report's data (without its id byte) against its description. False
 * when it holds nothing to act on: too short, or a keyboard's phantom state
 * (every slot ErrorRollOver). */
bool fos_hid_decode_keys(const fos_hid_report_t *report, const uint8_t *data, size_t len, fos_hid_keys_t *out);
bool fos_hid_decode_mouse(const fos_hid_report_t *report, const uint8_t *data, size_t len, fos_hid_mouse_t *out);

/* What changed from `before` to `after`, as key edges by usage: every
 * release first, then every press, modifiers included (usage 0xE0 + bit). */
typedef void (*fos_hid_key_fn)(void *arg, uint8_t usage, bool down);
void fos_hid_keys_diff(const fos_hid_keys_t *before, const fos_hid_keys_t *after, fos_hid_key_fn fn, void *arg);

/* The Linux KEY_* number of a keyboard usage (the kernel's hid-input.c
 * table), the numbers the dispatcher's keyboard tables are keyed by
 * (frameos/keyboard_gen.nim); 0 for a usage with none. */
uint16_t fos_hid_usage_linux_key(uint8_t usage);
/* Whether a usage is a modifier key (no auto-repeat). */
bool fos_hid_usage_is_modifier(uint8_t usage);

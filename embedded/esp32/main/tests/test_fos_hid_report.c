/*
 * Host tests for the pure half of the Bluetooth keyboard and mouse
 * (fos_hid_report.c): report descriptors as real devices send them, the
 * decode of their reports, key edges and the usage -> Linux key table.
 *
 * Build and run (from embedded/esp32/):
 *
 *   cc -std=c11 -Wall -Wextra -Werror -O2 -Imain \
 *      main/fos_hid_report.c main/tests/test_fos_hid_report.c \
 *      -o /tmp/test_fos_hid_report && /tmp/test_fos_hid_report
 *
 * (backend/app/tasks/tests/test_esp32_hid_report.py does exactly that in CI.)
 */
#include <stdio.h>
#include <string.h>

#include "fos_hid_report.h"

static int g_failures = 0;
static int g_checks = 0;

#define CHECK(cond, ...)                                                       \
    do {                                                                       \
        g_checks++;                                                            \
        if (!(cond)) {                                                         \
            g_failures++;                                                      \
            printf("FAIL %s:%d: ", __func__, __LINE__);                        \
            printf(__VA_ARGS__);                                               \
            printf("\n");                                                      \
        }                                                                      \
    } while (0)

/* A BLE keyboard: report 1 the keyboard (with its LED output report between),
 * report 2 a consumer control the frame does not read. */
static const uint8_t k_keyboard[] = {
    0x05, 0x01, 0x09, 0x06, 0xA1, 0x01, 0x85, 0x01, 0x05, 0x07, 0x19, 0xE0, 0x29, 0xE7, 0x15, 0x00,
    0x25, 0x01, 0x75, 0x01, 0x95, 0x08, 0x81, 0x02, 0x95, 0x01, 0x75, 0x08, 0x81, 0x01, 0x95, 0x05,
    0x75, 0x01, 0x05, 0x08, 0x19, 0x01, 0x29, 0x05, 0x91, 0x02, 0x95, 0x01, 0x75, 0x03, 0x91, 0x01,
    0x95, 0x06, 0x75, 0x08, 0x15, 0x00, 0x25, 0x65, 0x05, 0x07, 0x19, 0x00, 0x29, 0x65, 0x81, 0x00,
    0xC0,
    0x05, 0x0C, 0x09, 0x01, 0xA1, 0x01, 0x85, 0x02, 0x15, 0x00, 0x26, 0xFF, 0x03, 0x19, 0x00, 0x2A,
    0xFF, 0x03, 0x75, 0x10, 0x95, 0x01, 0x81, 0x00, 0xC0,
};

/* A BLE mouse: sixteen buttons, 12-bit motion, a wheel and a horizontal pan. */
static const uint8_t k_mouse[] = {
    0x05, 0x01, 0x09, 0x02, 0xA1, 0x01, 0x85, 0x02, 0x09, 0x01, 0xA1, 0x00, 0x05, 0x09, 0x19, 0x01,
    0x29, 0x10, 0x15, 0x00, 0x25, 0x01, 0x95, 0x10, 0x75, 0x01, 0x81, 0x02, 0x05, 0x01, 0x16, 0x01,
    0xF8, 0x26, 0xFF, 0x07, 0x75, 0x0C, 0x95, 0x02, 0x09, 0x30, 0x09, 0x31, 0x81, 0x06, 0x15, 0x81,
    0x25, 0x7F, 0x75, 0x08, 0x95, 0x01, 0x09, 0x38, 0x81, 0x06, 0x05, 0x0C, 0x0A, 0x38, 0x02, 0x95,
    0x01, 0x81, 0x06, 0xC0, 0xC0,
};

/* An NKRO keyboard: the modifiers, then one bit per usage 0x00..0x67. */
static const uint8_t k_nkro[] = {
    0x05, 0x01, 0x09, 0x06, 0xA1, 0x01, 0x85, 0x03, 0x05, 0x07, 0x19, 0xE0, 0x29, 0xE7, 0x15, 0x00,
    0x25, 0x01, 0x75, 0x01, 0x95, 0x08, 0x81, 0x02, 0x05, 0x07, 0x19, 0x00, 0x29, 0x67, 0x95, 0x68,
    0x75, 0x01, 0x81, 0x02, 0xC0,
};

static void test_keyboard_map(void)
{
    fos_hid_map_t map;
    CHECK(fos_hid_parse_map(k_keyboard, sizeof(k_keyboard), &map) == 1, "one usable report, got %u", map.count);
    const fos_hid_report_t *r = fos_hid_find(&map, 1);
    CHECK(r != NULL, "report 1");
    if (!r) return;
    CHECK(r->kind == FOS_HID_KIND_KEYBOARD, "a keyboard");
    CHECK(r->bits == 64, "64 bits, got %u", r->bits);
    CHECK(r->mods.bit == 0 && r->mods.size == 8, "mods at 0");
    CHECK(r->keys.bit == 16 && r->keys.size == 8 && r->keys_count == 6, "six keys at byte 2, got %u/%u/%u",
          r->keys.bit, r->keys.size, r->keys_count);
    CHECK(fos_hid_find(&map, 2) == NULL, "the consumer report is not read");

    const uint8_t data[8] = {0x02, 0x00, 0x04, 0x28, 0, 0, 0, 0}; /* LShift, a, Enter */
    fos_hid_keys_t keys;
    CHECK(fos_hid_decode_keys(r, data, sizeof(data), &keys), "decodes");
    CHECK(keys.mods == 0x02 && keys.count == 2 && keys.keys[0] == 0x04 && keys.keys[1] == 0x28, "shift+a+enter");

    const uint8_t rollover[8] = {0, 0, 1, 1, 1, 1, 1, 1};
    CHECK(!fos_hid_decode_keys(r, rollover, sizeof(rollover), &keys), "ErrorRollOver is no state");
}

static void test_mouse_map(void)
{
    fos_hid_map_t map;
    CHECK(fos_hid_parse_map(k_mouse, sizeof(k_mouse), &map) == 1, "one report");
    const fos_hid_report_t *r = fos_hid_find(&map, 2);
    CHECK(r != NULL && r->kind == FOS_HID_KIND_MOUSE, "report 2 a mouse");
    if (!r) return;
    CHECK(r->buttons.bit == 0 && r->buttons.size == 8, "eight of the buttons kept");
    CHECK(r->x.bit == 16 && r->x.size == 12, "x 12 bits at 16, got %u/%u", r->x.bit, r->x.size);
    CHECK(r->y.bit == 28 && r->y.size == 12, "y 12 bits at 28, got %u/%u", r->y.bit, r->y.size);
    CHECK(r->wheel.bit == 40 && r->wheel.size == 8, "wheel at 40, got %u/%u", r->wheel.bit, r->wheel.size);
    CHECK(r->pan.bit == 48 && r->pan.size == 8, "pan at 48, got %u/%u", r->pan.bit, r->pan.size);
    CHECK(r->bits == 56, "56 bits, got %u", r->bits);

    /* Left button, x +5, y -3, wheel -1 (a notch towards the user). */
    const uint8_t data[7] = {0x01, 0x00, 0x05, 0xD0, 0xFF, 0xFF, 0x00};
    fos_hid_mouse_t m;
    CHECK(fos_hid_decode_mouse(r, data, sizeof(data), &m), "decodes");
    CHECK(m.buttons == 1 && m.dx == 5 && m.dy == -3 && m.wheel == -1 && m.pan == 0,
          "got buttons %u dx %d dy %d wheel %d pan %d", m.buttons, m.dx, m.dy, m.wheel, m.pan);
    CHECK(!fos_hid_decode_mouse(r, data, 3, &m), "a short report is refused");
}

static void test_nkro(void)
{
    fos_hid_map_t map;
    CHECK(fos_hid_parse_map(k_nkro, sizeof(k_nkro), &map) == 1, "one report");
    const fos_hid_report_t *r = fos_hid_find(&map, 3);
    if (!r) {
        CHECK(0, "report 3");
        return;
    }
    CHECK(r->map.bit == 8 && r->map.size == 104 && r->map_min == 0, "the bitmap, got %u/%u/%u", r->map.bit,
          r->map.size, r->map_min);
    uint8_t data[14] = {0};
    data[1] = 0x10; /* usage 4: bit 8 + 4 */
    data[5] = 0x01; /* usage 0x20 ('3'): bit 8 + 32 = byte 5 bit 0 */
    fos_hid_keys_t keys;
    CHECK(fos_hid_decode_keys(r, data, sizeof(data), &keys), "decodes");
    CHECK(keys.count == 2 && keys.keys[0] == 0x04 && keys.keys[1] == 0x20, "a and 3, got %u keys", keys.count);
}

static void test_boot(void)
{
    fos_hid_report_t kb, mouse;
    fos_hid_boot_keyboard(&kb);
    fos_hid_boot_mouse(&mouse);
    const uint8_t k[8] = {0x01, 0, 0x06, 0, 0, 0, 0, 0}; /* LCtrl+c */
    fos_hid_keys_t keys;
    CHECK(fos_hid_decode_keys(&kb, k, sizeof(k), &keys) && keys.mods == 1 && keys.count == 1 && keys.keys[0] == 6,
          "ctrl+c");
    const uint8_t m[3] = {0x02, 0xFE, 0x03}; /* right button, x -2, y +3, no wheel byte */
    fos_hid_mouse_t mm;
    CHECK(fos_hid_decode_mouse(&mouse, m, sizeof(m), &mm), "a three-byte boot report");
    CHECK(mm.buttons == 2 && mm.dx == -2 && mm.dy == 3 && mm.wheel == 0, "got %u %d %d %d", mm.buttons, mm.dx, mm.dy,
          mm.wheel);
}

typedef struct {
    uint8_t usage[16];
    bool down[16];
    int n;
} edges_t;

static void record(void *arg, uint8_t usage, bool down)
{
    edges_t *e = arg;
    if (e->n < 16) {
        e->usage[e->n] = usage;
        e->down[e->n] = down;
        e->n++;
    }
}

static void test_diff(void)
{
    fos_hid_keys_t a = {.mods = 0, .keys = {0x04}, .count = 1};
    fos_hid_keys_t b = {.mods = 0x02, .keys = {0x04, 0x05}, .count = 2};
    fos_hid_keys_t c = {.mods = 0, .keys = {0x05}, .count = 1};
    edges_t e = {0};
    fos_hid_keys_diff(&a, &b, record, &e);
    CHECK(e.n == 2 && e.usage[0] == 0xE1 && e.down[0] && e.usage[1] == 0x05 && e.down[1], "shift then b down");
    memset(&e, 0, sizeof(e));
    fos_hid_keys_diff(&b, &c, record, &e);
    CHECK(e.n == 2 && e.usage[0] == 0x04 && !e.down[0] && e.usage[1] == 0xE1 && !e.down[1], "a up then shift up");
}

static void test_linux_keys(void)
{
    CHECK(fos_hid_usage_linux_key(0x04) == 30, "a is KEY_A");
    CHECK(fos_hid_usage_linux_key(0x1E) == 2, "1 is KEY_1");
    CHECK(fos_hid_usage_linux_key(0x28) == 28, "Enter");
    CHECK(fos_hid_usage_linux_key(0x29) == 1, "Escape");
    CHECK(fos_hid_usage_linux_key(0x2C) == 57, "Space");
    CHECK(fos_hid_usage_linux_key(0x45) == 88, "F12");
    CHECK(fos_hid_usage_linux_key(0x4F) == 106 && fos_hid_usage_linux_key(0x52) == 103, "Right, Up");
    CHECK(fos_hid_usage_linux_key(0x64) == 86, "the ISO key next to left shift");
    CHECK(fos_hid_usage_linux_key(0xE1) == 42 && fos_hid_usage_linux_key(0xE6) == 100, "LShift, RAlt");
    CHECK(fos_hid_usage_linux_key(0x90) == 0, "a usage with no key");
    CHECK(fos_hid_usage_is_modifier(0xE3) && !fos_hid_usage_is_modifier(0x04), "modifiers");
}

static void test_garbage(void)
{
    fos_hid_map_t map;
    const uint8_t truncated[] = {0x05, 0x01, 0x09, 0x06, 0xA1, 0x01, 0x85};
    CHECK(fos_hid_parse_map(truncated, sizeof(truncated), &map) == 0, "a cut descriptor gives nothing");
    const uint8_t huge[] = {0x05, 0x01, 0x09, 0x02, 0xA1, 0x01, 0x75, 0xFF, 0x97, 0xFF, 0xFF, 0x00, 0x00, 0x81, 0x02};
    CHECK(fos_hid_parse_map(huge, sizeof(huge), &map) == 0, "an impossible report is refused");
}

int main(void)
{
    test_keyboard_map();
    test_mouse_map();
    test_nkro();
    test_boot();
    test_diff();
    test_linux_keys();
    test_garbage();
    printf("%d checks, %d failures\n", g_checks, g_failures);
    return g_failures ? 1 : 0;
}

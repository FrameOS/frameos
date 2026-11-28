#include "fos_hid_report.h"

#include <string.h>

/* Usage pages and usages read here (HID Usage Tables 1.5). */
#define PAGE_GENERIC_DESKTOP 0x01
#define PAGE_KEYBOARD 0x07
#define PAGE_BUTTON 0x09
#define PAGE_CONSUMER 0x0C
#define USAGE_MOUSE 0x02
#define USAGE_KEYBOARD 0x06
#define USAGE_X 0x30
#define USAGE_Y 0x31
#define USAGE_WHEEL 0x38
#define USAGE_AC_PAN 0x0238

#define LOCAL_USAGES_MAX 16
#define STACK_DEPTH 4

typedef struct {
    uint16_t page;
    int32_t logical_min;
    uint32_t report_size;
    uint32_t report_count;
    uint8_t report_id;
} globals_t;

static fos_hid_report_t *report_for(fos_hid_map_t *map, uint8_t id, uint8_t kind)
{
    for (uint8_t i = 0; i < map->count; i++) {
        if (map->reports[i].id == id) return &map->reports[i];
    }
    if (map->count >= FOS_HID_REPORTS_MAX) return NULL;
    fos_hid_report_t *r = &map->reports[map->count++];
    memset(r, 0, sizeof(*r));
    r->id = id;
    r->kind = kind;
    return r;
}

static void set_field(fos_hid_field_t *field, uint32_t bit, uint32_t size)
{
    if (field->size == 0 && size > 0 && size <= 32 && bit < 0xFFFF) {
        field->bit = (uint16_t)bit;
        field->size = (uint8_t)size;
    }
}

int fos_hid_parse_map(const uint8_t *desc, size_t len, fos_hid_map_t *out)
{
    memset(out, 0, sizeof(*out));
    globals_t g = {0}, stack[STACK_DEPTH];
    int depth = 0;
    /* Locals: cleared after every main item. Usages carry their page in the
     * high half when the item gave one (a 4-byte usage). */
    uint32_t usages[LOCAL_USAGES_MAX];
    int usage_count = 0;
    uint32_t usage_min = 0, usage_max = 0;
    bool have_range = false;
    /* What the outermost application collection is: a keyboard or a mouse.
     * A report's kind is the collection it starts in. */
    uint8_t app_kind = FOS_HID_KIND_NONE;
    int collection_depth = 0;
    /* The input bits laid down so far, per report id (index = id). Static:
     * the caller is the Bluetooth host's task, whose stack is small. */
    static uint16_t offsets[256];
    memset(offsets, 0, sizeof(offsets));

    size_t i = 0;
    while (i < len) {
        uint8_t prefix = desc[i++];
        if (prefix == 0xFE) {
            /* A long item: its size byte, its tag byte, its data. */
            if (i + 2 > len) break;
            i += 2 + desc[i];
            continue;
        }
        uint8_t size_code = prefix & 0x03;
        size_t size = size_code == 3 ? 4 : size_code;
        uint8_t type = (prefix >> 2) & 0x03;
        uint8_t tag = prefix >> 4;
        if (i + size > len) break;
        uint32_t value = 0;
        for (size_t b = 0; b < size; b++) value |= (uint32_t)desc[i + b] << (8 * b);
        int32_t svalue = (int32_t)value;
        if (size == 1) svalue = (int8_t)value;
        else if (size == 2) svalue = (int16_t)value;
        i += size;

        if (type == 1) { /* global */
            switch (tag) {
            case 0x0: g.page = (uint16_t)value; break;
            case 0x1: g.logical_min = svalue; break;
            case 0x7: g.report_size = value; break;
            case 0x8: g.report_id = (uint8_t)value; break;
            case 0x9: g.report_count = value; break;
            case 0xA: if (depth < STACK_DEPTH) stack[depth++] = g; break;
            case 0xB: if (depth > 0) g = stack[--depth]; break;
            default: break;
            }
            continue;
        }
        if (type == 2) { /* local */
            uint32_t usage = size == 4 ? value : ((uint32_t)g.page << 16) | value;
            if (tag == 0x0 && usage_count < LOCAL_USAGES_MAX) usages[usage_count++] = usage;
            else if (tag == 0x1) { usage_min = usage; have_range = true; }
            else if (tag == 0x2) { usage_max = usage; have_range = true; }
            continue;
        }
        if (type != 0) continue; /* reserved */

        /* A main item. */
        if (tag == 0xA) { /* collection */
            if (collection_depth == 0 && value == 0x01 && usage_count > 0) {
                uint32_t usage = usages[0];
                if (usage == ((PAGE_GENERIC_DESKTOP << 16) | USAGE_KEYBOARD)) app_kind = FOS_HID_KIND_KEYBOARD;
                else if (usage == ((PAGE_GENERIC_DESKTOP << 16) | USAGE_MOUSE)) app_kind = FOS_HID_KIND_MOUSE;
                else app_kind = FOS_HID_KIND_NONE;
            }
            collection_depth++;
        } else if (tag == 0xC) { /* end collection */
            if (collection_depth > 0) collection_depth--;
            if (collection_depth == 0) app_kind = FOS_HID_KIND_NONE;
        } else if (tag == 0x8) { /* input */
            uint32_t start = offsets[g.report_id];
            uint32_t total = g.report_size * g.report_count;
            if (total > 0xFFFF || start + total > 0xFFFF) break;
            offsets[g.report_id] = (uint16_t)(start + total);
            bool constant = value & 0x01;
            bool variable = value & 0x02;
            fos_hid_report_t *r = NULL;
            if (app_kind != FOS_HID_KIND_NONE && !constant) r = report_for(out, g.report_id, app_kind);
            if (r) {
                uint16_t page = (uint16_t)((usage_count > 0 ? usages[0] : usage_min) >> 16);
                if (page == 0) page = g.page;
                if (!variable) {
                    /* An array: the usages held, each a number. A keyboard's
                     * keys (a consumer page's array is not read). */
                    if (page == PAGE_KEYBOARD && r->keys.size == 0 && g.report_size <= 8) {
                        set_field(&r->keys, start, g.report_size);
                        r->keys_count = (uint8_t)(g.report_count > 255 ? 255 : g.report_count);
                    }
                } else {
                    for (uint32_t n = 0; n < g.report_count; n++) {
                        uint32_t usage;
                        if (have_range) usage = usage_min + n;
                        else if (usage_count > 0) usage = usages[n < (uint32_t)usage_count ? n : (uint32_t)usage_count - 1];
                        else break;
                        if (have_range && usage > usage_max) break;
                        uint16_t upage = (uint16_t)(usage >> 16);
                        uint16_t uid = (uint16_t)usage;
                        if (upage == 0) upage = g.page;
                        uint32_t bit = start + n * g.report_size;
                        if (upage == PAGE_KEYBOARD) {
                            if (uid == 0xE0 && g.report_size == 1) set_field(&r->mods, bit, 8);
                            else if (uid < 0xE0 && g.report_size == 1 && r->map.size == 0 && have_range) {
                                /* A bitmap of keys (NKRO), one bit a usage from
                                 * here to the range's end or the modifiers. `size`
                                 * is its length in bits here, not a field's. */
                                uint32_t last = (uint16_t)usage_max < 0xE0 ? (uint16_t)usage_max : 0xDF;
                                uint32_t span = last >= uid ? last - uid + 1 : 0;
                                if (span > g.report_count - n) span = g.report_count - n;
                                r->map.bit = (uint16_t)bit;
                                r->map.size = (uint8_t)(span > 255 ? 255 : span);
                                r->map_min = (uint8_t)uid;
                            }
                        } else if (upage == PAGE_BUTTON) {
                            if (r->buttons.size == 0) {
                                uint32_t count = g.report_count - n;
                                set_field(&r->buttons, bit, count > 8 ? 8 : count);
                            }
                            break;
                        } else if (upage == PAGE_GENERIC_DESKTOP) {
                            if (uid == USAGE_X) set_field(&r->x, bit, g.report_size);
                            else if (uid == USAGE_Y) set_field(&r->y, bit, g.report_size);
                            else if (uid == USAGE_WHEEL) set_field(&r->wheel, bit, g.report_size);
                        } else if (upage == PAGE_CONSUMER && uid == USAGE_AC_PAN) {
                            set_field(&r->pan, bit, g.report_size);
                        }
                    }
                }
            }
        }
        /* Every main item ends the locals. */
        usage_count = 0;
        usage_min = usage_max = 0;
        have_range = false;
    }
    for (uint8_t n = 0; n < out->count; n++) {
        fos_hid_report_t *r = &out->reports[n];
        r->bits = offsets[r->id];
    }
    /* Keep only what can be read as a keyboard or a mouse. */
    uint8_t kept = 0;
    for (uint8_t n = 0; n < out->count; n++) {
        fos_hid_report_t *r = &out->reports[n];
        bool usable = r->kind == FOS_HID_KIND_KEYBOARD ? (r->keys.size || r->map.size || r->mods.size)
                                                       : (r->x.size && r->y.size);
        if (usable) out->reports[kept++] = *r;
    }
    out->count = kept;
    return kept;
}

const fos_hid_report_t *fos_hid_find(const fos_hid_map_t *map, uint8_t id)
{
    for (uint8_t i = 0; i < map->count; i++) {
        if (map->reports[i].id == id) return &map->reports[i];
    }
    return NULL;
}

void fos_hid_boot_keyboard(fos_hid_report_t *out)
{
    memset(out, 0, sizeof(*out));
    out->kind = FOS_HID_KIND_KEYBOARD;
    out->bits = 64;
    out->mods = (fos_hid_field_t){.bit = 0, .size = 8};
    out->keys = (fos_hid_field_t){.bit = 16, .size = 8};
    out->keys_count = 6;
}

void fos_hid_boot_mouse(fos_hid_report_t *out)
{
    memset(out, 0, sizeof(*out));
    out->kind = FOS_HID_KIND_MOUSE;
    out->bits = 32;
    out->buttons = (fos_hid_field_t){.bit = 0, .size = 3};
    out->x = (fos_hid_field_t){.bit = 8, .size = 8};
    out->y = (fos_hid_field_t){.bit = 16, .size = 8};
    out->wheel = (fos_hid_field_t){.bit = 24, .size = 8};
}

/* `size` bits from `bit`, little-endian as HID lays them; 0 past the end. */
static uint32_t bits_at(const uint8_t *data, size_t len, uint32_t bit, uint32_t size)
{
    uint32_t value = 0;
    for (uint32_t n = 0; n < size; n++) {
        uint32_t at = bit + n;
        if (at / 8 >= len) break;
        if (data[at / 8] & (1u << (at % 8))) value |= 1u << n;
    }
    return value;
}

static int32_t signed_at(const uint8_t *data, size_t len, fos_hid_field_t field)
{
    if (field.size == 0) return 0;
    uint32_t raw = bits_at(data, len, field.bit, field.size);
    if (field.size < 32 && (raw & (1u << (field.size - 1)))) raw |= ~0u << field.size;
    return (int32_t)raw;
}

static int16_t clamp16(int32_t v)
{
    return (int16_t)(v > 32767 ? 32767 : v < -32768 ? -32768 : v);
}

bool fos_hid_decode_keys(const fos_hid_report_t *r, const uint8_t *data, size_t len, fos_hid_keys_t *out)
{
    memset(out, 0, sizeof(*out));
    if (len * 8 < (size_t)(r->bits > 8 ? 8 : r->bits)) return false;
    if (r->mods.size) out->mods = (uint8_t)bits_at(data, len, r->mods.bit, 8);
    for (uint8_t n = 0; n < r->keys_count && r->keys.size; n++) {
        uint32_t usage = bits_at(data, len, r->keys.bit + (uint32_t)n * r->keys.size, r->keys.size);
        if (usage == 0x01) return false; /* ErrorRollOver: too many keys, the state is a phantom */
        if (usage < 0x04 || usage > 0xFF) continue;
        if (out->count < FOS_HID_KEYS_MAX) out->keys[out->count++] = (uint8_t)usage;
    }
    for (uint32_t n = 0; n < r->map.size; n++) {
        if (bits_at(data, len, r->map.bit + n, 1) && out->count < FOS_HID_KEYS_MAX) {
            uint32_t usage = r->map_min + n;
            if (usage >= 0x04 && usage < 0xE0) out->keys[out->count++] = (uint8_t)usage;
        }
    }
    return true;
}

bool fos_hid_decode_mouse(const fos_hid_report_t *r, const uint8_t *data, size_t len, fos_hid_mouse_t *out)
{
    memset(out, 0, sizeof(*out));
    if (len * 8 < (size_t)r->y.bit + r->y.size) return false;
    out->buttons = (uint8_t)bits_at(data, len, r->buttons.bit, r->buttons.size);
    out->dx = clamp16(signed_at(data, len, r->x));
    out->dy = clamp16(signed_at(data, len, r->y));
    /* A boot mouse's wheel byte is optional: absent, it reads as 0. */
    out->wheel = clamp16(signed_at(data, len, r->wheel));
    out->pan = clamp16(signed_at(data, len, r->pan));
    return true;
}

static bool holds(const fos_hid_keys_t *k, uint8_t usage)
{
    for (uint8_t i = 0; i < k->count; i++) {
        if (k->keys[i] == usage) return true;
    }
    return false;
}

void fos_hid_keys_diff(const fos_hid_keys_t *before, const fos_hid_keys_t *after, fos_hid_key_fn fn, void *arg)
{
    uint8_t mods_up = before->mods & (uint8_t)~after->mods;
    uint8_t mods_down = after->mods & (uint8_t)~before->mods;
    for (uint8_t i = 0; i < before->count; i++) {
        if (!holds(after, before->keys[i])) fn(arg, before->keys[i], false);
    }
    for (int b = 0; b < 8; b++) {
        if (mods_up & (1u << b)) fn(arg, (uint8_t)(0xE0 + b), false);
    }
    for (int b = 0; b < 8; b++) {
        if (mods_down & (1u << b)) fn(arg, (uint8_t)(0xE0 + b), true);
    }
    for (uint8_t i = 0; i < after->count; i++) {
        if (!holds(before, after->keys[i])) fn(arg, after->keys[i], true);
    }
}

/* Usages 0x00..0x73 (through F24); the kernel's drivers/hid/hid-input.c. */
static const uint8_t k_usage_linux[0x74] = {
      0,   0,   0,   0,  30,  48,  46,  32,  18,  33,  34,  35,  23,  36,  37,  38,
     50,  49,  24,  25,  16,  19,  31,  20,  22,  47,  17,  45,  21,  44,   2,   3,
      4,   5,   6,   7,   8,   9,  10,  11,  28,   1,  14,  15,  57,  12,  13,  26,
     27,  43,  43,  39,  40,  41,  51,  52,  53,  58,  59,  60,  61,  62,  63,  64,
     65,  66,  67,  68,  87,  88,  99,  70, 119, 110, 102, 104, 111, 107, 109, 106,
    105, 108, 103,  69,  98,  55,  74,  78,  96,  79,  80,  81,  75,  76,  77,  71,
     72,  73,  82,  83,  86, 127, 116, 117, 183, 184, 185, 186, 187, 188, 189, 190,
    191, 192, 193, 194,
};
/* Usages 0xE0..0xE7: LeftControl, LeftShift, LeftAlt, LeftGUI, then right. */
static const uint8_t k_modifier_linux[8] = {29, 42, 56, 125, 97, 54, 100, 126};

uint16_t fos_hid_usage_linux_key(uint8_t usage)
{
    if (usage < sizeof(k_usage_linux)) return k_usage_linux[usage];
    if (usage >= 0xE0 && usage <= 0xE7) return k_modifier_linux[usage - 0xE0];
    return 0;
}

bool fos_hid_usage_is_modifier(uint8_t usage)
{
    return usage >= 0xE0 && usage <= 0xE7;
}

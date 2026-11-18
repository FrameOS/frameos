#include "fos_bt.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "sdkconfig.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include <sys/stat.h>

#include "fos_assets.h"
#include "fos_client.h"
#include "fos_config.h"
#include "fos_events.h"
#include "fos_events_gen.h"
#include "fos_hid_report.h"
#include "frameos_nim.h"

#if CONFIG_BT_NIMBLE_ENABLED
#include "esp_bt.h"
#include "nvs.h"
#include "host/ble_hs.h"
#include "host/util/util.h"
#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"
/* NimBLE's NVS-backed bond store (CONFIG_BT_NIMBLE_NVS_PERSIST); IDF ships
 * no header for it. */
void ble_store_config_init(void);
#endif

/* ------------------------------------------------------------- the queue */

/* What the render task hands the dispatcher, in the order it happened. Motion
 * and wheel turns fold into the newest of their kind when nothing else came
 * between, so a mouse at 130 reports a second over a 1 s render is a few
 * events, and no press moves past a motion. */
typedef enum {
    BT_KEY_DOWN = 0,
    BT_KEY_UP,
    BT_KEY_REPEAT,
    BT_MOVE,
    BT_BUTTON_DOWN,
    BT_BUTTON_UP,
    BT_WHEEL,
    BT_MOUSE_GONE,
} bt_kind_t;

typedef struct {
    uint8_t kind;
    uint8_t code;    /* key usage, or mouse button */
    uint8_t buttons; /* a mouse's buttons held after it */
    int16_t dx, dy;  /* motion; a wheel's pan and turn */
    int64_t at_ms;
} bt_event_t;

#define BT_QUEUE_LEN 64
static portMUX_TYPE s_queue_lock = portMUX_INITIALIZER_UNLOCKED;
static bt_event_t s_queue[BT_QUEUE_LEN];
static uint8_t s_head = 0, s_count = 0;
static uint32_t s_dropped = 0;

static int16_t add16(int16_t a, int16_t b)
{
    int32_t v = (int32_t)a + b;
    return (int16_t)(v > 32767 ? 32767 : v < -32768 ? -32768 : v);
}

static void enqueue(bt_event_t event)
{
    event.at_ms = esp_timer_get_time() / 1000;
    portENTER_CRITICAL(&s_queue_lock);
    if ((event.kind == BT_MOVE || event.kind == BT_WHEEL) && s_count > 0) {
        bt_event_t *last = &s_queue[(s_head + s_count - 1) % BT_QUEUE_LEN];
        if (last->kind == event.kind) {
            last->dx = add16(last->dx, event.dx);
            last->dy = add16(last->dy, event.dy);
            last->buttons = event.buttons;
            portEXIT_CRITICAL(&s_queue_lock);
            return;
        }
    }
    if (s_count == BT_QUEUE_LEN) {
        s_dropped++;
        portEXIT_CRITICAL(&s_queue_lock);
        return;
    }
    s_queue[(s_head + s_count) % BT_QUEUE_LEN] = event;
    s_count++;
    portEXIT_CRITICAL(&s_queue_lock);
    fos_client_wake_for_events();
}

static bool dequeue(bt_event_t *out)
{
    portENTER_CRITICAL(&s_queue_lock);
    if (s_count == 0) {
        portEXIT_CRITICAL(&s_queue_lock);
        return false;
    }
    *out = s_queue[s_head];
    s_head = (uint8_t)((s_head + 1) % BT_QUEUE_LEN);
    s_count--;
    portEXIT_CRITICAL(&s_queue_lock);
    return true;
}

/* The frame's own keyboard layout: `keyboard.json` at the top of its
 * storage (put there like any asset, from either plane), in the contract's
 * layout shape (frameos/keyboard_tables.nim). Read on the render task when
 * the stack starts and when a keyboard connects (a stat on a 24 MB SPIFFS is
 * half a second: never per key), again only when its size or time moved. */
#define BT_LAYOUT_FILE "keyboard.json"
#define BT_LAYOUT_MAX 4096
static volatile bool s_layout_due = false;

static void check_layout(void)
{
    static off_t s_size = -1;
    static time_t s_mtime = 0;
    struct stat st;
    bool present = fos_assets_available() && fos_assets_stat(BT_LAYOUT_FILE, &st) == ESP_OK;
    off_t size = present ? st.st_size : -1;
    time_t mtime = present ? st.st_mtime : 0;
    if (size == s_size && mtime == s_mtime) return;
    s_size = size;
    s_mtime = mtime;
    if (!present) {
        frameos_nim_set_keyboard_layout_json("");
        return;
    }
    if (size <= 0 || size > BT_LAYOUT_MAX) {
        frameos_nim_log_hook("{\"event\":\"bt:layout\",\"source\":\"esp32\",\"error\":\"keyboard.json: 1 to 4096 bytes\"}");
        return;
    }
    char path[160];
    fos_assets_full_path(path, sizeof(path), BT_LAYOUT_FILE);
    FILE *f = fopen(path, "rb");
    char *text = f ? malloc((size_t)size + 1) : NULL;
    size_t got = text ? fread(text, 1, (size_t)size, f) : 0;
    if (f) fclose(f);
    if (text) {
        text[got] = '\0';
        frameos_nim_set_keyboard_layout_json(text);
        free(text);
    }
}

bool fos_bt_pending(void)
{
    return s_count > 0 || s_layout_due;
}

bool fos_bt_process_events(void)
{
    bt_event_t e;
    bool any = false;
    if (s_layout_due) {
        s_layout_due = false;
        check_layout();
    }
    /* What is queued now and no more (fos_touch_process_events's rule). */
    uint8_t budget = s_count;
    while (budget-- > 0 && dequeue(&e)) {
        char payload[128];
        const char *name = NULL;
        switch (e.kind) {
        case BT_KEY_DOWN:
        case BT_KEY_REPEAT:
        case BT_KEY_UP: {
            uint16_t linux_code = fos_hid_usage_linux_key(e.code);
            if (linux_code == 0) continue;
            name = e.kind == BT_KEY_UP ? FOS_EVENT_KEY_UP : FOS_EVENT_KEY_DOWN;
            snprintf(payload, sizeof(payload), "{\"linuxCode\":%u%s}", linux_code,
                     e.kind == BT_KEY_REPEAT ? ",\"repeat\":true" : "");
            break;
        }
        case BT_MOVE:
            name = FOS_EVENT_POINTER_MOVE;
            snprintf(payload, sizeof(payload),
                     "{\"pointerId\":0,\"pointerType\":\"mouse\",\"movementX\":%d,\"movementY\":%d,\"buttons\":%u}",
                     e.dx, e.dy, e.buttons);
            break;
        case BT_BUTTON_DOWN:
        case BT_BUTTON_UP:
            name = e.kind == BT_BUTTON_DOWN ? FOS_EVENT_POINTER_DOWN : FOS_EVENT_POINTER_UP;
            snprintf(payload, sizeof(payload),
                     "{\"pointerId\":0,\"pointerType\":\"mouse\",\"button\":%u,\"buttons\":%u,\"atMs\":%lld}", e.code,
                     e.buttons, (long long)e.at_ms);
            break;
        case BT_WHEEL:
            /* HID's wheel is positive away from the user; the DOM's deltaY
             * is positive scrolling down, towards them. */
            name = FOS_EVENT_WHEEL;
            snprintf(payload, sizeof(payload), "{\"deltaX\":%d,\"deltaY\":%d}", e.dx, -e.dy);
            break;
        case BT_MOUSE_GONE:
            name = FOS_EVENT_POINTER_CANCEL;
            snprintf(payload, sizeof(payload), "{\"pointerId\":0,\"pointerType\":\"mouse\"}");
            break;
        default:
            continue;
        }
        fos_events_dispatch(FOS_ORIGIN_DRIVER, name, payload);
        any = true;
    }
    return any;
}

#if CONFIG_BT_NIMBLE_ENABLED

static const char *TAG = "fos_bt";

static void log_line(const char *line)
{
    frameos_nim_log_hook(line);
}

/* ---------------------------------------------------------- key repeat */

/* A held key repeats as on a computer: a BLE keyboard sends the key once,
 * and the host repeats it. Modifiers do not repeat. */
#define BT_REPEAT_DELAY_MS 500
#define BT_REPEAT_EVERY_MS 40
static esp_timer_handle_t s_repeat_timer = NULL;
static volatile uint8_t s_repeat_usage = 0;

static void repeat_fire(void *arg)
{
    (void)arg;
    uint8_t usage = s_repeat_usage;
    if (usage == 0) return;
    enqueue((bt_event_t){.kind = BT_KEY_REPEAT, .code = usage});
    esp_timer_start_once(s_repeat_timer, BT_REPEAT_EVERY_MS * 1000);
}

static void key_edge(void *arg, uint8_t usage, bool down)
{
    (void)arg;
    enqueue((bt_event_t){.kind = down ? BT_KEY_DOWN : BT_KEY_UP, .code = usage});
    if (fos_hid_usage_is_modifier(usage) || !s_repeat_timer) return;
    if (down) {
        s_repeat_usage = usage;
        esp_timer_stop(s_repeat_timer);
        esp_timer_start_once(s_repeat_timer, BT_REPEAT_DELAY_MS * 1000);
    } else if (s_repeat_usage == usage) {
        s_repeat_usage = 0;
        esp_timer_stop(s_repeat_timer);
    }
}

/* ------------------------------------------------------------ devices */

#define BT_DEVICES_MAX CONFIG_BT_NIMBLE_MAX_CONNECTIONS
#define BT_CHRS_MAX 12
#define BT_MAP_MAX 1024
#define UUID_HID_SERVICE 0x1812
#define UUID_REPORT_MAP 0x2A4B
#define UUID_REPORT 0x2A4D
#define UUID_BOOT_KEYBOARD_IN 0x2A22
#define UUID_BOOT_MOUSE_IN 0x2A33
#define UUID_PROTOCOL_MODE 0x2A4E
#define UUID_REPORT_REF 0x2908
#define UUID_CCCD 0x2902
#define UUID_DEVICE_NAME 0x2A00
#define BT_NAME_MAX 24
#define BT_KNOWN_MAX CONFIG_BT_NIMBLE_MAX_BONDS

typedef enum { CHR_REPORT = 0, CHR_BOOT_KEYBOARD, CHR_BOOT_MOUSE } chr_kind_t;

typedef struct {
    uint16_t def, val, end; /* the characteristic's handles */
    uint16_t ref, cccd;     /* its Report Reference and its CCCD, 0 for none */
    uint8_t kind;           /* chr_kind_t */
    uint8_t id, type;       /* the report's id and type (1 input) */
} bt_chr_t;

typedef enum {
    STEP_SERVICE = 0,
    STEP_CHARACTERISTICS,
    STEP_DESCRIPTORS,
    STEP_MAP,
    STEP_REFERENCES,
    STEP_SUBSCRIBE,
    STEP_NAME,
    STEP_READY,
} bt_step_t;

typedef struct {
    bool used;
    uint16_t conn;
    ble_addr_t addr;
    uint8_t step;
    uint8_t cursor;
    bool boot;              /* no usable report map: the boot protocol */
    uint16_t svc_start, svc_end;
    uint16_t map_handle, mode_handle;
    bt_chr_t chrs[BT_CHRS_MAX];
    uint8_t chr_count;
    uint8_t *map_buf;
    uint16_t map_len;
    fos_hid_map_t map;
    fos_hid_keys_t keys;    /* the keyboard as its last report left it */
    uint8_t buttons;        /* the mouse's buttons, likewise */
    bool keyboard, mouse;
    char name[BT_NAME_MAX];  /* its GAP device name, "" until read */
} bt_dev_t;

/* What the frame knows of a bonded device beyond the bond NimBLE keeps: its
 * name and what it is, for the frame page and `bt` (NVS `fos_bt` / `devs`).
 * A bond from before this list shows as its address. */
typedef struct {
    uint8_t addr[6];
    uint8_t type;
    uint8_t kinds;          /* bit 0 keyboard, bit 1 mouse */
    char name[BT_NAME_MAX];
} bt_known_t;

static bt_dev_t s_devs[BT_DEVICES_MAX];
static uint8_t s_own_addr_type = 0;
static bool s_started = false, s_synced = false;
static volatile int64_t s_pair_until_us = 0;
static int s_connecting = -1; /* the slot a connect is under way for */
static bt_known_t s_known[BT_KNOWN_MAX];
static void (*s_change_hook)(void) = NULL;
static esp_timer_handle_t s_pair_timer = NULL;
/* The device list as the page reads it, from another task than the host's:
 * a slot's step, kinds and name are written, and read for the page, under
 * this. */
static portMUX_TYPE s_devs_lock = portMUX_INITIALIZER_UNLOCKED;

static void changed(void)
{
    void (*hook)(void) = s_change_hook;
    if (hook) hook();
}

static void known_load(void)
{
    nvs_handle_t nvs;
    if (nvs_open("fos_bt", NVS_READONLY, &nvs) != ESP_OK) return;
    size_t len = sizeof(s_known);
    if (nvs_get_blob(nvs, "devs", s_known, &len) != ESP_OK || len != sizeof(s_known)) memset(s_known, 0, sizeof(s_known));
    nvs_close(nvs);
}

static void known_save(void)
{
    nvs_handle_t nvs;
    if (nvs_open("fos_bt", NVS_READWRITE, &nvs) != ESP_OK) return;
    nvs_set_blob(nvs, "devs", s_known, sizeof(s_known));
    nvs_commit(nvs);
    nvs_close(nvs);
}

static bool known_used(const bt_known_t *k)
{
    static const uint8_t none[6] = {0};
    return memcmp(k->addr, none, 6) != 0;
}

static bt_known_t *known_find(const uint8_t addr[6])
{
    for (int i = 0; i < BT_KNOWN_MAX; i++) {
        if (known_used(&s_known[i]) && memcmp(s_known[i].addr, addr, 6) == 0) return &s_known[i];
    }
    return NULL;
}

static bt_dev_t *dev_by_conn(uint16_t conn)
{
    for (int i = 0; i < BT_DEVICES_MAX; i++) {
        if (s_devs[i].used && s_devs[i].conn == conn) return &s_devs[i];
    }
    return NULL;
}

static bool addr_connected(const ble_addr_t *addr)
{
    for (int i = 0; i < BT_DEVICES_MAX; i++) {
        if (s_devs[i].used && memcmp(s_devs[i].addr.val, addr->val, 6) == 0) return true;
    }
    return false;
}

static int free_slot(void)
{
    for (int i = 0; i < BT_DEVICES_MAX; i++) {
        if (!s_devs[i].used) return i;
    }
    return -1;
}

static void addr_text(const ble_addr_t *addr, char *out, size_t len)
{
    const uint8_t *v = addr->val;
    snprintf(out, len, "%02x:%02x:%02x:%02x:%02x:%02x", v[5], v[4], v[3], v[2], v[1], v[0]);
}

static void log_dev(const char *event, const bt_dev_t *d, const char *extra)
{
    char addr[18], line[192];
    addr_text(&d->addr, addr, sizeof(addr));
    snprintf(line, sizeof(line), "{\"event\":\"%s\",\"source\":\"esp32\",\"address\":\"%s\"%s}", event, addr,
             extra ? extra : "");
    log_line(line);
}

/* Let go of whatever a device held: a keyboard's keys go up, a mouse's held
 * press is cancelled. */
static void release_held(bt_dev_t *d)
{
    fos_hid_keys_t none = {0};
    fos_hid_keys_diff(&d->keys, &none, key_edge, NULL);
    d->keys = none;
    if (d->buttons) enqueue((bt_event_t){.kind = BT_MOUSE_GONE});
    d->buttons = 0;
}

static void drop_dev(bt_dev_t *d)
{
    release_held(d);
    free(d->map_buf);
    portENTER_CRITICAL(&s_devs_lock);
    memset(d, 0, sizeof(*d));
    portEXIT_CRITICAL(&s_devs_lock);
}

static void start_scan(void);
static void advance(bt_dev_t *d);
static void finish(bt_dev_t *d);
static int on_name(uint16_t conn, const struct ble_gatt_error *error, struct ble_gatt_attr *attr, void *arg);
static bool wanted(bt_dev_t *d, const bt_chr_t *c);

static void fail(bt_dev_t *d, const char *what, int rc)
{
    char extra[96];
    snprintf(extra, sizeof(extra), ",\"step\":\"%s\",\"rc\":%d", what, rc);
    log_dev("bt:error", d, extra);
    ble_gap_terminate(d->conn, BLE_ERR_REM_USER_CONN_TERM);
}

/* --------------------------------------------------------- the reports */

static void on_mouse(bt_dev_t *d, const fos_hid_mouse_t *m)
{
    if (m->dx || m->dy) enqueue((bt_event_t){.kind = BT_MOVE, .dx = m->dx, .dy = m->dy, .buttons = d->buttons});
    uint8_t changed = (uint8_t)(m->buttons ^ d->buttons);
    uint8_t held = d->buttons;
    for (uint8_t b = 0; b < 8; b++) {
        if (!(changed & (1u << b))) continue;
        held ^= (uint8_t)(1u << b);
        bool down = m->buttons & (1u << b);
        enqueue((bt_event_t){.kind = down ? BT_BUTTON_DOWN : BT_BUTTON_UP, .code = b, .buttons = held});
    }
    d->buttons = m->buttons;
    if (m->wheel || m->pan) enqueue((bt_event_t){.kind = BT_WHEEL, .dx = m->pan, .dy = m->wheel});
}

static void on_report(bt_dev_t *d, const bt_chr_t *c, const uint8_t *data, size_t len)
{
    fos_hid_report_t boot;
    const fos_hid_report_t *r = NULL;
    if (c->kind == CHR_BOOT_KEYBOARD) {
        fos_hid_boot_keyboard(&boot);
        r = &boot;
    } else if (c->kind == CHR_BOOT_MOUSE) {
        fos_hid_boot_mouse(&boot);
        r = &boot;
    } else {
        r = fos_hid_find(&d->map, c->id);
    }
    if (!r) return;
    if (r->kind == FOS_HID_KIND_KEYBOARD) {
        fos_hid_keys_t keys;
        if (!fos_hid_decode_keys(r, data, len, &keys)) return;
        fos_hid_keys_diff(&d->keys, &keys, key_edge, NULL);
        d->keys = keys;
    } else {
        fos_hid_mouse_t m;
        if (fos_hid_decode_mouse(r, data, len, &m)) on_mouse(d, &m);
    }
}

/* ----------------------------------------------------- the discovery */

static int on_service(uint16_t conn, const struct ble_gatt_error *error, const struct ble_gatt_svc *svc, void *arg)
{
    bt_dev_t *d = arg;
    if (error->status == 0 && svc) {
        d->svc_start = svc->start_handle;
        d->svc_end = svc->end_handle;
        return 0;
    }
    if (error->status != BLE_HS_EDONE || d->svc_start == 0) {
        fail(d, "service", error->status);
        return 0;
    }
    d->step = STEP_CHARACTERISTICS;
    advance(d);
    return 0;
}

static int on_characteristic(uint16_t conn, const struct ble_gatt_error *error, const struct ble_gatt_chr *chr,
                             void *arg)
{
    bt_dev_t *d = arg;
    if (error->status == 0 && chr) {
        /* Where the one before ends: just before this one begins. */
        if (d->chr_count > 0 && d->chrs[d->chr_count - 1].end == 0) d->chrs[d->chr_count - 1].end = chr->def_handle - 1;
        uint16_t uuid = ble_uuid_u16(&chr->uuid.u);
        int kind = uuid == UUID_REPORT ? CHR_REPORT
                   : uuid == UUID_BOOT_KEYBOARD_IN ? CHR_BOOT_KEYBOARD
                   : uuid == UUID_BOOT_MOUSE_IN ? CHR_BOOT_MOUSE
                                                : -1;
        if (uuid == UUID_REPORT_MAP) d->map_handle = chr->val_handle;
        if (uuid == UUID_PROTOCOL_MODE) d->mode_handle = chr->val_handle;
        if (kind >= 0 && (chr->properties & BLE_GATT_CHR_PROP_NOTIFY) && d->chr_count < BT_CHRS_MAX) {
            bt_chr_t *c = &d->chrs[d->chr_count++];
            memset(c, 0, sizeof(*c));
            c->def = chr->def_handle;
            c->val = chr->val_handle;
            c->kind = (uint8_t)kind;
        }
        return 0;
    }
    if (error->status != BLE_HS_EDONE) {
        fail(d, "characteristics", error->status);
        return 0;
    }
    if (d->chr_count > 0 && d->chrs[d->chr_count - 1].end == 0) d->chrs[d->chr_count - 1].end = d->svc_end;
    d->step = STEP_DESCRIPTORS;
    d->cursor = 0;
    advance(d);
    return 0;
}

static int on_descriptor(uint16_t conn, const struct ble_gatt_error *error, uint16_t chr_val_handle,
                         const struct ble_gatt_dsc *dsc, void *arg)
{
    bt_dev_t *d = arg;
    bt_chr_t *c = &d->chrs[d->cursor];
    if (error->status == 0 && dsc) {
        uint16_t uuid = ble_uuid_u16(&dsc->uuid.u);
        if (uuid == UUID_REPORT_REF) c->ref = dsc->handle;
        else if (uuid == UUID_CCCD) c->cccd = dsc->handle;
        return 0;
    }
    if (error->status != BLE_HS_EDONE) {
        fail(d, "descriptors", error->status);
        return 0;
    }
    d->cursor++;
    advance(d);
    return 0;
}

static int on_map(uint16_t conn, const struct ble_gatt_error *error, struct ble_gatt_attr *attr, void *arg)
{
    bt_dev_t *d = arg;
    if (error->status == 0 && attr) {
        uint16_t chunk = OS_MBUF_PKTLEN(attr->om);
        if (d->map_len + chunk > BT_MAP_MAX) return BLE_HS_ENOMEM;
        uint8_t *grown = realloc(d->map_buf, d->map_len + chunk);
        if (!grown) return BLE_HS_ENOMEM;
        d->map_buf = grown;
        ble_hs_mbuf_to_flat(attr->om, d->map_buf + d->map_len, chunk, NULL);
        d->map_len += chunk;
        return 0;
    }
    if (error->status != BLE_HS_EDONE) {
        fail(d, "report map", error->status);
        return 0;
    }
    fos_hid_parse_map(d->map_buf, d->map_len, &d->map);
    free(d->map_buf);
    d->map_buf = NULL;
    d->boot = d->map.count == 0;
    d->step = STEP_REFERENCES;
    d->cursor = 0;
    advance(d);
    return 0;
}

static int on_reference(uint16_t conn, const struct ble_gatt_error *error, struct ble_gatt_attr *attr, void *arg)
{
    bt_dev_t *d = arg;
    bt_chr_t *c = &d->chrs[d->cursor];
    if (error->status == 0 && attr) {
        uint8_t ref[2] = {0};
        ble_hs_mbuf_to_flat(attr->om, ref, sizeof(ref), NULL);
        c->id = ref[0];
        c->type = ref[1];
    }
    d->cursor++;
    advance(d);
    return 0;
}

static int on_subscribed(uint16_t conn, const struct ble_gatt_error *error, struct ble_gatt_attr *attr, void *arg)
{
    bt_dev_t *d = arg;
    (void)attr;
    if (error->status != 0) {
        fail(d, "subscribe", error->status);
        return 0;
    }
    d->cursor++;
    advance(d);
    return 0;
}

/* The link is ready: what it is, kept with its name, and the page told. */
static void finish(bt_dev_t *d)
{
    bool keyboard = false, mouse = false;
    for (uint8_t i = 0; i < d->chr_count; i++) {
        const bt_chr_t *c = &d->chrs[i];
        if (!wanted(d, c)) continue;
        const fos_hid_report_t *r = d->boot ? NULL : fos_hid_find(&d->map, c->id);
        if (c->kind == CHR_BOOT_KEYBOARD || (r && r->kind == FOS_HID_KIND_KEYBOARD)) keyboard = true;
        if (c->kind == CHR_BOOT_MOUSE || (r && r->kind == FOS_HID_KIND_MOUSE)) mouse = true;
    }
    portENTER_CRITICAL(&s_devs_lock);
    d->keyboard = keyboard;
    d->mouse = mouse;
    d->step = STEP_READY;
    portEXIT_CRITICAL(&s_devs_lock);
    char extra[96];
    snprintf(extra, sizeof(extra), ",\"keyboard\":%s,\"mouse\":%s,\"reports\":%u,\"boot\":%s",
             keyboard ? "true" : "false", mouse ? "true" : "false", d->map.count, d->boot ? "true" : "false");
    log_dev("bt:connected", d, extra);
    if (!keyboard && !mouse) {
        fail(d, "nothing to read", 0);
        return;
    }
    /* Kept by address: a new device takes a free record, else the oldest's. */
    uint8_t kinds = (uint8_t)((keyboard ? 1 : 0) | (mouse ? 2 : 0));
    bt_known_t *k = known_find(d->addr.val);
    if (!k) {
        for (int i = 0; i < BT_KNOWN_MAX && !k; i++) {
            if (!known_used(&s_known[i])) k = &s_known[i];
        }
        if (!k) {
            memmove(&s_known[0], &s_known[1], sizeof(s_known[0]) * (BT_KNOWN_MAX - 1));
            k = &s_known[BT_KNOWN_MAX - 1];
        }
        memset(k, 0, sizeof(*k));
        memcpy(k->addr, d->addr.val, 6);
    }
    if (k->type != d->addr.type || k->kinds != kinds || strcmp(k->name, d->name) != 0) {
        k->type = d->addr.type;
        k->kinds = kinds;
        strlcpy(k->name, d->name, sizeof(k->name));
        known_save();
    }
    if (keyboard) {
        s_layout_due = true; /* a keyboard.json put there since */
        fos_client_wake_for_events();
    }
    changed();
    start_scan(); /* for the other slot */
}

static int on_name(uint16_t conn, const struct ble_gatt_error *error, struct ble_gatt_attr *attr, void *arg)
{
    bt_dev_t *d = arg;
    if (error->status == 0 && attr) {
        char name[BT_NAME_MAX] = {0};
        ble_hs_mbuf_to_flat(attr->om, name, sizeof(name) - 1, NULL);
        portENTER_CRITICAL(&s_devs_lock);
        strlcpy(d->name, name, sizeof(d->name));
        portEXIT_CRITICAL(&s_devs_lock);
        return 0;
    }
    /* Done, or no name served: ready either way. */
    if (d->step == STEP_NAME) finish(d);
    return 0;
}

/* Whether this characteristic's notifications are read: an input report the
 * map describes, or in boot mode the boot reports. */
static bool wanted(bt_dev_t *d, const bt_chr_t *c)
{
    if (!c->cccd) return false;
    if (d->boot) return c->kind != CHR_REPORT;
    return c->kind == CHR_REPORT && c->type == 1 && fos_hid_find(&d->map, c->id) != NULL;
}

/* The next step of the discovery: each callback ends its step and calls this
 * on the host's task. */
static void advance(bt_dev_t *d)
{
    int rc = 0;
    switch (d->step) {
    case STEP_SERVICE:
        rc = ble_gattc_disc_svc_by_uuid(d->conn, BLE_UUID16_DECLARE(UUID_HID_SERVICE), on_service, d);
        break;
    case STEP_CHARACTERISTICS:
        rc = ble_gattc_disc_all_chrs(d->conn, d->svc_start, d->svc_end, on_characteristic, d);
        break;
    case STEP_DESCRIPTORS:
        while (d->cursor < d->chr_count && d->chrs[d->cursor].end <= d->chrs[d->cursor].val) d->cursor++;
        if (d->cursor < d->chr_count) {
            bt_chr_t *c = &d->chrs[d->cursor];
            rc = ble_gattc_disc_all_dscs(d->conn, c->val, c->end, on_descriptor, d);
            break;
        }
        d->step = STEP_MAP;
        if (d->map_handle) {
            rc = ble_gattc_read_long(d->conn, d->map_handle, 0, on_map, d);
            break;
        }
        d->boot = true;
        d->step = STEP_REFERENCES;
        d->cursor = 0;
        /* fall through */
    case STEP_REFERENCES:
        while (d->cursor < d->chr_count && !(d->chrs[d->cursor].kind == CHR_REPORT && d->chrs[d->cursor].ref)) {
            d->cursor++;
        }
        if (!d->boot && d->cursor < d->chr_count) {
            rc = ble_gattc_read(d->conn, d->chrs[d->cursor].ref, on_reference, d);
            break;
        }
        d->step = STEP_SUBSCRIBE;
        d->cursor = 0;
        if (d->boot && d->mode_handle) {
            /* Report mode is the default; a device whose map we cannot read
             * speaks the boot protocol when asked. */
            uint8_t boot_mode = 0;
            ble_gattc_write_no_rsp_flat(d->conn, d->mode_handle, &boot_mode, 1);
        }
        /* fall through */
    case STEP_SUBSCRIBE:
        while (d->cursor < d->chr_count && !wanted(d, &d->chrs[d->cursor])) d->cursor++;
        if (d->cursor < d->chr_count) {
            static const uint8_t notify_on[2] = {0x01, 0x00};
            rc = ble_gattc_write_flat(d->conn, d->chrs[d->cursor].cccd, notify_on, sizeof(notify_on), on_subscribed, d);
            break;
        }
        d->step = STEP_NAME;
        /* fall through */
    case STEP_NAME: {
        /* Its name, for the frame page: kept from an earlier connection, or
         * the GAP Device Name it serves. */
        const bt_known_t *k = known_find(d->addr.val);
        if (k && k->name[0]) {
            portENTER_CRITICAL(&s_devs_lock);
            strlcpy(d->name, k->name, sizeof(d->name));
            portEXIT_CRITICAL(&s_devs_lock);
            finish(d);
            return;
        }
        rc = ble_gattc_read_by_uuid(d->conn, 1, 0xFFFF, BLE_UUID16_DECLARE(UUID_DEVICE_NAME), on_name, d);
        if (rc != 0) {
            finish(d); /* nameless: its address will do */
            return;
        }
        break;
    }
    default:
        return;
    }
    if (rc != 0) fail(d, "gatt", rc);
}

/* -------------------------------------------------------------- GAP */

static int gap_event(struct ble_gap_event *event, void *arg);

static bool bonded(const ble_addr_t *addr)
{
    struct ble_store_key_sec key = {.peer_addr = *addr};
    /* An address the controller resolved is an identity address (type 2 or
     * 3): the store keys bonds by the plain type. */
    if (key.peer_addr.type >= 2) key.peer_addr.type -= 2;
    struct ble_store_value_sec value;
    return ble_store_read_peer_sec(&key, &value) == 0;
}

static bool advertises_hid(const struct ble_gap_disc_desc *disc)
{
    struct ble_hs_adv_fields fields;
    if (ble_hs_adv_parse_fields(&fields, disc->data, disc->length_data) != 0) return false;
    for (int i = 0; i < fields.num_uuids16; i++) {
        if (ble_uuid_u16(&fields.uuids16[i].u) == UUID_HID_SERVICE) return true;
    }
    /* 0x03C0..0x03CF: the HID appearances (keyboard 0x03C1, mouse 0x03C2). */
    return fields.appearance_is_present && (fields.appearance & 0xFFC0) == 0x03C0;
}

static void consider(const struct ble_gap_disc_desc *disc)
{
    if (s_connecting >= 0 || addr_connected(&disc->addr)) return;
    int slot = free_slot();
    if (slot < 0) return;
    bool directed = disc->event_type == BLE_HCI_ADV_RPT_EVTYPE_DIR_IND;
    if (!directed && disc->event_type != BLE_HCI_ADV_RPT_EVTYPE_ADV_IND) return;
    bool known = bonded(&disc->addr);
    bool pairing = esp_timer_get_time() < s_pair_until_us;
    if (!known && !(pairing && !directed && advertises_hid(disc))) return;
    ble_gap_disc_cancel();
    bt_dev_t *d = &s_devs[slot];
    memset(d, 0, sizeof(*d));
    d->addr = disc->addr;
    int rc = ble_gap_connect(s_own_addr_type, &disc->addr, 10000, NULL, gap_event, NULL);
    if (rc != 0) {
        start_scan();
        return;
    }
    d->used = true;
    d->conn = BLE_HS_CONN_HANDLE_NONE;
    s_connecting = slot;
}

static void start_scan(void)
{
    if (!s_synced || s_connecting >= 0 || free_slot() < 0 || ble_gap_disc_active()) return;
    bool pairing = esp_timer_get_time() < s_pair_until_us;
    /* Pairing: a quick look. Otherwise a slow one, for a bonded device that
     * wakes and advertises to come back (its high-duty directed bursts last
     * 1.28 s; a 30 ms window every second meets them). Passive: nothing is
     * sent. */
    struct ble_gap_disc_params params = {
        .itvl = pairing ? 0x00A0 : 0x0640,
        .window = 0x0030,
        .filter_policy = 0,
        .limited = 0,
        .passive = 1,
        .filter_duplicates = 1,
    };
    int32_t duration_ms = pairing ? (int32_t)((s_pair_until_us - esp_timer_get_time()) / 1000) : 60000;
    if (duration_ms < 1000) duration_ms = 1000;
    int rc = ble_gap_disc(s_own_addr_type, duration_ms, &params, gap_event, NULL);
    if (rc != 0 && rc != BLE_HS_EALREADY) ESP_LOGW(TAG, "scan: %d", rc);
}

static int gap_event(struct ble_gap_event *event, void *arg)
{
    (void)arg;
    switch (event->type) {
    case BLE_GAP_EVENT_DISC:
        consider(&event->disc);
        return 0;
    case BLE_GAP_EVENT_DISC_COMPLETE:
        start_scan();
        return 0;
    case BLE_GAP_EVENT_CONNECT: {
        int slot = s_connecting;
        s_connecting = -1;
        if (slot < 0) return 0;
        bt_dev_t *d = &s_devs[slot];
        if (event->connect.status != 0) {
            memset(d, 0, sizeof(*d));
            start_scan();
            return 0;
        }
        d->conn = event->connect.conn_handle;
        /* Encrypted first, from the bond or by pairing: a HID device answers
         * nothing of its reports on a link that is not. */
        int rc = ble_gap_security_initiate(d->conn);
        if (rc != 0) fail(d, "security", rc);
        start_scan();
        return 0;
    }
    case BLE_GAP_EVENT_DISCONNECT: {
        bt_dev_t *d = dev_by_conn(event->disconnect.conn.conn_handle);
        if (d) {
            char extra[32];
            snprintf(extra, sizeof(extra), ",\"reason\":%d", event->disconnect.reason);
            log_dev("bt:disconnected", d, extra);
            bool was_ready = d->step == STEP_READY;
            drop_dev(d);
            if (was_ready) changed();
        }
        start_scan();
        return 0;
    }
    case BLE_GAP_EVENT_ENC_CHANGE: {
        bt_dev_t *d = dev_by_conn(event->enc_change.conn_handle);
        if (!d) return 0;
        if (event->enc_change.status != 0) {
            fail(d, "pairing", event->enc_change.status);
            return 0;
        }
        if (d->step == STEP_SERVICE && d->svc_start == 0) advance(d);
        return 0;
    }
    case BLE_GAP_EVENT_REPEAT_PAIRING: {
        /* The device lost its bond and pairs again: forget ours. */
        struct ble_gap_conn_desc desc;
        if (ble_gap_conn_find(event->repeat_pairing.conn_handle, &desc) == 0) {
            ble_store_util_delete_peer(&desc.peer_id_addr);
        }
        return BLE_GAP_REPEAT_PAIRING_RETRY;
    }
    case BLE_GAP_EVENT_NOTIFY_RX: {
        bt_dev_t *d = dev_by_conn(event->notify_rx.conn_handle);
        if (!d || d->step != STEP_READY) return 0;
        for (uint8_t i = 0; i < d->chr_count; i++) {
            if (d->chrs[i].val != event->notify_rx.attr_handle) continue;
            uint8_t data[64];
            uint16_t len = 0;
            ble_hs_mbuf_to_flat(event->notify_rx.om, data, sizeof(data), &len);
            on_report(d, &d->chrs[i], data, len);
            break;
        }
        return 0;
    }
    default:
        return 0;
    }
}

static void on_sync(void)
{
    ble_hs_util_ensure_addr(0);
    ble_hs_id_infer_auto(0, &s_own_addr_type);
    s_synced = true;
    log_line("{\"event\":\"bt:ready\",\"source\":\"esp32\"}");
    start_scan();
}

static void on_reset(int reason)
{
    s_synced = false;
    char line[96];
    snprintf(line, sizeof(line), "{\"event\":\"bt:reset\",\"source\":\"esp32\",\"reason\":%d}", reason);
    log_line(line);
}

static void host_task(void *arg)
{
    (void)arg;
    nimble_port_run();
    nimble_port_freertos_deinit();
}

/* The pairing window closed: the page shows Pair again. */
static void pair_ended(void *arg)
{
    (void)arg;
    changed();
}

esp_err_t fos_bt_start(void)
{
    if (!fos_config()->bluetooth) {
        /* Never on this boot: the controller's static RAM goes back to the
         * heap (irreversible until a restart, which `set bluetooth 1` asks for). */
        esp_bt_controller_mem_release(ESP_BT_MODE_BLE);
        return ESP_OK;
    }
    const esp_timer_create_args_t repeat = {.callback = repeat_fire, .name = "fos_bt_repeat"};
    if (esp_timer_create(&repeat, &s_repeat_timer) != ESP_OK) s_repeat_timer = NULL;
    esp_err_t err = nimble_port_init();
    if (err != ESP_OK) {
        char line[96];
        snprintf(line, sizeof(line), "{\"event\":\"bt:error\",\"source\":\"esp32\",\"step\":\"init\",\"rc\":%d}", err);
        log_line(line);
        return err;
    }
    ble_hs_cfg.sync_cb = on_sync;
    ble_hs_cfg.reset_cb = on_reset;
    ble_hs_cfg.store_status_cb = ble_store_util_status_rr;
    /* No display or keys of its own to show or type a passkey with: "Just
     * Works" pairing, bonded so the device comes back by itself. */
    ble_hs_cfg.sm_io_cap = BLE_SM_IO_CAP_NO_IO;
    ble_hs_cfg.sm_bonding = 1;
    ble_hs_cfg.sm_mitm = 0;
    ble_hs_cfg.sm_sc = 1;
    ble_hs_cfg.sm_our_key_dist = BLE_SM_PAIR_KEY_DIST_ENC | BLE_SM_PAIR_KEY_DIST_ID;
    ble_hs_cfg.sm_their_key_dist = BLE_SM_PAIR_KEY_DIST_ENC | BLE_SM_PAIR_KEY_DIST_ID;
    ble_store_config_init();
    known_load();
    const esp_timer_create_args_t pair_end = {.callback = pair_ended, .name = "fos_bt_pair"};
    if (esp_timer_create(&pair_end, &s_pair_timer) != ESP_OK) s_pair_timer = NULL;
    nimble_port_freertos_init(host_task);
    s_started = true;
    s_layout_due = true;
    return ESP_OK;
}

void fos_bt_pair(uint32_t seconds)
{
    if (!s_started) {
        printf("bluetooth is off: set bluetooth 1, then restart\n");
        return;
    }
    s_pair_until_us = seconds ? esp_timer_get_time() + (int64_t)seconds * 1000000 : 0;
    if (s_pair_timer) {
        esp_timer_stop(s_pair_timer);
        if (seconds) esp_timer_start_once(s_pair_timer, (uint64_t)seconds * 1000000);
    }
    ble_gap_disc_cancel();
    start_scan();
    changed();
    char line[96];
    snprintf(line, sizeof(line), "{\"event\":\"bt:pairing\",\"source\":\"esp32\",\"seconds\":%lu}",
             (unsigned long)seconds);
    log_line(line);
}

void fos_bt_forget(void)
{
    if (!s_started) return;
    for (int i = 0; i < BT_DEVICES_MAX; i++) {
        if (s_devs[i].used && s_devs[i].conn != BLE_HS_CONN_HANDLE_NONE) {
            ble_gap_terminate(s_devs[i].conn, BLE_ERR_REM_USER_CONN_TERM);
        }
    }
    ble_store_clear();
    memset(s_known, 0, sizeof(s_known));
    known_save();
    log_line("{\"event\":\"bt:forgotten\",\"source\":\"esp32\"}");
    changed();
}

/* "aa:bb:cc:dd:ee:ff" as printed (most significant first) to NimBLE's order. */
static bool parse_addr(const char *text, uint8_t out[6])
{
    unsigned v[6];
    if (!text || sscanf(text, "%2x:%2x:%2x:%2x:%2x:%2x", &v[5], &v[4], &v[3], &v[2], &v[1], &v[0]) != 6) return false;
    for (int i = 0; i < 6; i++) out[i] = (uint8_t)v[i];
    return true;
}

bool fos_bt_forget_one(const char *address)
{
    uint8_t val[6];
    if (!s_started || !parse_addr(address, val)) return false;
    bool found = false;
    for (int i = 0; i < BT_DEVICES_MAX; i++) {
        if (s_devs[i].used && memcmp(s_devs[i].addr.val, val, 6) == 0 && s_devs[i].conn != BLE_HS_CONN_HANDLE_NONE) {
            ble_gap_terminate(s_devs[i].conn, BLE_ERR_REM_USER_CONN_TERM);
            found = true;
        }
    }
    /* The bond by its identity address, whichever type it was kept as. */
    ble_addr_t bonds[BT_KNOWN_MAX];
    int count = 0;
    ble_store_util_bonded_peers(bonds, &count, BT_KNOWN_MAX);
    for (int i = 0; i < count; i++) {
        if (memcmp(bonds[i].val, val, 6) == 0) {
            ble_store_util_delete_peer(&bonds[i]);
            found = true;
        }
    }
    bt_known_t *k = known_find(val);
    if (k) {
        memset(k, 0, sizeof(*k));
        known_save();
        found = true;
    }
    if (found) {
        char line[96];
        snprintf(line, sizeof(line), "{\"event\":\"bt:forgotten\",\"source\":\"esp32\",\"address\":\"%s\"}",
                 address);
        log_line(line);
        changed();
    }
    return found;
}

void fos_bt_set_change_hook(void (*hook)(void))
{
    s_change_hook = hook;
}

/* `"text"`, JSON-escaped, into buf at *n. */
static void put_json_string(char *buf, size_t cap, size_t *n, const char *text)
{
    if (*n + 1 < cap) buf[(*n)++] = '"';
    for (const unsigned char *c = (const unsigned char *)text; *c && *n + 7 < cap; c++) {
        if (*c == '"' || *c == '\\') {
            buf[(*n)++] = '\\';
            buf[(*n)++] = (char)*c;
        } else if (*c < 0x20) {
            *n += (size_t)snprintf(buf + *n, cap - *n, "\\u%04x", *c);
        } else {
            buf[(*n)++] = (char)*c;
        }
    }
    if (*n + 1 < cap) buf[(*n)++] = '"';
    buf[*n < cap ? *n : cap - 1] = '\0';
}

size_t fos_bt_facts_json(char *buf, size_t cap)
{
    if (cap < 64) return 0;
    size_t n;
    if (!s_started) {
        n = (size_t)snprintf(buf, cap, ",\"bluetooth\":{\"on\":%s}", fos_config()->bluetooth ? "true" : "false");
        return n < cap ? n : 0;
    }
    n = (size_t)snprintf(buf, cap, ",\"bluetooth\":{\"on\":%s,\"ready\":%s,\"pairing\":%s,\"devices\":[",
                         fos_config()->bluetooth ? "true" : "false", s_synced ? "true" : "false",
                         esp_timer_get_time() < s_pair_until_us ? "true" : "false");
    /* Every bond: the known list's name and kinds, connected or not. A
     * bond without a record (from before it) is its address alone. */
    ble_addr_t bonds[BT_KNOWN_MAX];
    int count = 0;
    ble_store_util_bonded_peers(bonds, &count, BT_KNOWN_MAX);
    for (int i = 0; i < count && n + 200 < cap; i++) {
        char addr[18];
        addr_text(&bonds[i], addr, sizeof(addr));
        bt_known_t k = {0};
        const bt_known_t *found = known_find(bonds[i].val);
        if (found) k = *found;
        bool connected = false;
        portENTER_CRITICAL(&s_devs_lock);
        for (int j = 0; j < BT_DEVICES_MAX; j++) {
            const bt_dev_t *d = &s_devs[j];
            if (d->used && d->step == STEP_READY && memcmp(d->addr.val, bonds[i].val, 6) == 0) {
                connected = true;
                if (!k.name[0]) strlcpy(k.name, d->name, sizeof(k.name));
                k.kinds |= (uint8_t)((d->keyboard ? 1 : 0) | (d->mouse ? 2 : 0));
            }
        }
        portEXIT_CRITICAL(&s_devs_lock);
        n += (size_t)snprintf(buf + n, cap - n, "%s{\"address\":\"%s\",\"name\":", i ? "," : "", addr);
        put_json_string(buf, cap, &n, k.name);
        n += (size_t)snprintf(buf + n, cap - n, ",\"keyboard\":%s,\"mouse\":%s,\"connected\":%s}",
                              (k.kinds & 1) ? "true" : "false", (k.kinds & 2) ? "true" : "false",
                              connected ? "true" : "false");
    }
    if (n + 3 < cap) n += (size_t)snprintf(buf + n, cap - n, "]}");
    return n < cap ? n : 0;
}

bool fos_bt_mouse_connected(void)
{
    for (int i = 0; i < BT_DEVICES_MAX; i++) {
        if (s_devs[i].used && s_devs[i].step == STEP_READY && s_devs[i].mouse) return true;
    }
    return false;
}

void fos_bt_print_status(void)
{
    if (!s_started) {
        printf("bluetooth:   off (set bluetooth 1, restart)\n");
        return;
    }
    ble_addr_t bonds[CONFIG_BT_NIMBLE_MAX_BONDS];
    int bond_count = 0;
    ble_store_util_bonded_peers(bonds, &bond_count, CONFIG_BT_NIMBLE_MAX_BONDS);
    int64_t pairing_s = (s_pair_until_us - esp_timer_get_time()) / 1000000;
    printf("bluetooth:   %s, %d bonded, %s, queue %u, dropped %lu\n", s_synced ? "ready" : "starting", bond_count,
           pairing_s > 0 ? "pairing" : "not pairing", s_count, (unsigned long)s_dropped);
    for (int i = 0; i < bond_count; i++) {
        char addr[18];
        addr_text(&bonds[i], addr, sizeof(addr));
        const bt_known_t *k = known_find(bonds[i].val);
        const char *state = "bonded";
        for (int j = 0; j < BT_DEVICES_MAX; j++) {
            const bt_dev_t *d = &s_devs[j];
            if (d->used && memcmp(d->addr.val, bonds[i].val, 6) == 0) {
                state = d->step == STEP_READY ? "connected" : "connecting";
            }
        }
        printf("  %s  %-24s %s%s%s\n", addr, k && k->name[0] ? k->name : "(no name)", state,
               k && (k->kinds & 1) ? ", keyboard" : "", k && (k->kinds & 2) ? ", mouse" : "");
    }
}

#else /* no Bluetooth in this image (the C3) */

bool fos_bt_forget_one(const char *address)
{
    (void)address;
    return false;
}
void fos_bt_set_change_hook(void (*hook)(void)) { (void)hook; }
size_t fos_bt_facts_json(char *buf, size_t cap)
{
    (void)buf;
    (void)cap;
    return 0;
}

esp_err_t fos_bt_start(void) { return ESP_OK; }
void fos_bt_pair(uint32_t seconds) { (void)seconds; printf("no Bluetooth in this firmware\n"); }
void fos_bt_forget(void) {}
bool fos_bt_mouse_connected(void) { return false; }
void fos_bt_print_status(void) { printf("bluetooth:   not in this firmware\n"); }

#endif

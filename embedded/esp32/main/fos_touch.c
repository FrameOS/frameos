#include "fos_touch.h"

#include <stdio.h>
#include <stdlib.h>

#include "fos_events_gen.h"
#include <string.h>

int fos_touch_decode(const uint8_t *report, size_t len, fos_touch_point_t *points, size_t max)
{
    if (!report || len < 1) return -1;
    uint8_t status = report[0];
    if ((status & FOS_TOUCH_STATUS_READY) == 0) return -1;
    int count = status & 0x0F;
    if (count > FOS_TOUCH_POINTS_MAX) return -1;
    if (len < 1 + (size_t)count * FOS_TOUCH_POINT_BYTES) return -1;
    int out = 0;
    for (int i = 0; i < count; i++) {
        const uint8_t *rec = report + 1 + (size_t)i * FOS_TOUCH_POINT_BYTES;
        if ((size_t)out >= max) break;
        /* track id, x low, x high, y low, y high, size low, size high, reserved */
        points[out].id = rec[0] & 0x0F;
        points[out].x = (uint16_t)(rec[1] | (rec[2] << 8));
        points[out].y = (uint16_t)(rec[3] | (rec[4] << 8));
        out++;
    }
    return out;
}

int fos_touch_decode_ft(const uint8_t *report, size_t len, fos_touch_point_t *points, size_t max)
{
    if (!report || len < 1) return -1;
    int count = report[0] & 0x0F;
    if (count > FOS_TOUCH_POINTS_MAX) return -1;
    if (len < 1 + (size_t)count * FOS_TOUCH_FT_POINT_BYTES) return -1;
    int out = 0;
    for (int i = 0; i < count; i++) {
        const uint8_t *rec = report + 1 + (size_t)i * FOS_TOUCH_FT_POINT_BYTES;
        if ((size_t)out >= max) break;
        int event = rec[0] >> 6;
        int id = rec[2] >> 4;
        if (event == FOS_TOUCH_FT_EVENT_UP || event == FOS_TOUCH_FT_EVENT_NONE || id == 0x0F) continue;
        points[out].id = (uint8_t)id;
        points[out].x = (uint16_t)(((rec[0] & 0x0F) << 8) | rec[1]);
        points[out].y = (uint16_t)(((rec[2] & 0x0F) << 8) | rec[3]);
        out++;
    }
    return out;
}

int fos_touch_wire(int value, int max)
{
    if (max <= 1) return 0;
    if (value < 0) value = 0;
    if (value > max - 1) value = max - 1;
    return (int)(((long)value * FOS_TOUCH_WIRE_MAX) / (max - 1));
}

bool fos_touch_glided(int dx, int dy, int x_max)
{
    if (dx < 0) dx = -dx;
    if (dy < 0) dy = -dy;
    return x_max > 0 && dx * 10 >= x_max && dx > 2 * dy;
}

int fos_touch_move_slot(const fos_touch_event_t *queue, size_t capacity, size_t head, size_t count, uint8_t id)
{
    for (size_t i = count; i-- > 0;) {
        size_t slot = (head + i) % capacity;
        if (queue[slot].id == id) return queue[slot].kind == FOS_TOUCH_MOVE ? (int)slot : -1;
    }
    return -1;
}

void fos_touch_passed_add(fos_touch_passed_t *passed, uint16_t x, uint16_t y)
{
    if (passed->count >= FOS_TOUCH_PASSED_MAX) {
        uint8_t kept = 0;
        for (uint8_t i = 0; i + 1 < passed->count; i += 2, kept++) {
            passed->xy[2 * kept] = passed->xy[2 * i];
            passed->xy[2 * kept + 1] = passed->xy[2 * i + 1];
        }
        uint8_t newest = (uint8_t)(passed->count - 1);
        passed->xy[2 * kept] = passed->xy[2 * newest];
        passed->xy[2 * kept + 1] = passed->xy[2 * newest + 1];
        passed->count = (uint8_t)(kept + 1);
    }
    passed->xy[2 * passed->count] = x;
    passed->xy[2 * passed->count + 1] = y;
    passed->count++;
}

int fos_touch_passed_json(const fos_touch_passed_t *passed, char *buf, size_t size)
{
    if (!passed || passed->count == 0 || size == 0) return 0;
    int len = snprintf(buf, size, ",\"points\":[");
    for (uint8_t i = 0; i < 2 * passed->count && len > 0 && (size_t)len < size; i++) {
        len += snprintf(buf + len, size - (size_t)len, i ? ",%u" : "%u", passed->xy[i]);
    }
    if (len <= 0 || (size_t)len + 2 > size) {
        buf[0] = '\0';
        return 0;
    }
    buf[len++] = ']';
    buf[len] = '\0';
    return len;
}

bool fos_touch_axes_swapped(int touch_x_max, int touch_y_max, int panel_width, int panel_height)
{
    if (touch_x_max <= 0 || touch_y_max <= 0 || panel_width <= 0 || panel_height <= 0) return false;
    if (touch_x_max == touch_y_max || panel_width == panel_height) return false;
    return (touch_x_max > touch_y_max) != (panel_width > panel_height);
}

fos_touch_beep_t fos_touch_beep_step(uint8_t kind, uint8_t id, bool captured, uint8_t *held, uint8_t *beeped)
{
    uint8_t bit = (uint8_t)(1u << id);
    if (kind == FOS_TOUCH_DOWN) {
        bool another = (*held & (uint8_t)~bit) != 0;
        *held |= bit;
        if (!captured) {
            *beeped &= (uint8_t)~bit;
            return FOS_TOUCH_BEEP_NONE;
        }
        *beeped |= bit;
        return another ? FOS_TOUCH_BEEP_SECOND_DOWN : FOS_TOUCH_BEEP_DOWN;
    }
    if (kind == FOS_TOUCH_UP) {
        *held &= (uint8_t)~bit;
        if ((*beeped & bit) == 0) return FOS_TOUCH_BEEP_NONE;
        *beeped &= (uint8_t)~bit;
        return FOS_TOUCH_BEEP_UP;
    }
    return FOS_TOUCH_BEEP_NONE;
}

fos_touch_edge_t fos_touch_edge_at(int x, int y, int width, int height)
{
    if (width < 4 * FOS_GESTURE_EDGE_PX || height < 4 * FOS_GESTURE_EDGE_PX) return FOS_TOUCH_EDGE_NONE;
    const int distance[] = {x, width - 1 - x, y, height - 1 - y};
    int best = FOS_GESTURE_EDGE_PX;
    fos_touch_edge_t edge = FOS_TOUCH_EDGE_NONE;
    for (int i = 0; i < 4; i++) {
        if (distance[i] < best) {
            best = distance[i];
            edge = (fos_touch_edge_t)(FOS_TOUCH_EDGE_LEFT + i);
        }
    }
    return edge;
}

int fos_touch_edge_step(fos_touch_edge_t edge, int dx, int dy)
{
    int inward, along;
    switch (edge) {
    case FOS_TOUCH_EDGE_LEFT: inward = dx; along = dy; break;
    case FOS_TOUCH_EDGE_RIGHT: inward = -dx; along = dy; break;
    case FOS_TOUCH_EDGE_TOP: inward = dy; along = dx; break;
    case FOS_TOUCH_EDGE_BOTTOM: inward = -dy; along = dx; break;
    default: return -1;
    }
    if (inward >= FOS_GESTURE_SWIPE_MIN_PX && inward > abs(along)) return 1;
    if (abs(along) <= FOS_GESTURE_TAP_SLOP_PX || abs(along) < inward) return 0;
    return -1;
}

#ifdef ESP_PLATFORM
#include "driver/gpio.h"
#include "driver/i2c_master.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_sleep.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "soc/soc_caps.h"
#if SOC_PM_SUPPORT_EXT0_WAKEUP
#include "driver/rtc_io.h"
#endif

#include "fos_board.h"
#include "fos_buzzer.h"
#include "fos_client.h"
#include "fos_config.h"
#include "fos_events.h"
#include "fos_i2c.h"
#include "fos_usb_pads.h"
#include "fos_events_gen.h"
#include "frameos_display.h"
#include "frameos_nim.h"

static const char *TAG = "fos_touch";

#define TOUCH_I2C_HZ 400000
/* What the GT911 gets on every firmware known to run the reTerminal Sticky's
 * panel: the bus has only the chip's weak pull-ups behind it. */
#define TOUCH_GT911_I2C_HZ 100000
#define TOUCH_I2C_TIMEOUT_MS 50
/* The panel's supply switch to a controller that answers (Seeed's demos). */
#define TOUCH_POWER_SETTLE_MS 250
/* While a finger is down the controller pulses INT per report (~100 Hz);
 * a poll at this rate catches a release whose pulse was missed. Idle, the
 * task sleeps until the line moves. */
#define TOUCH_POLL_HELD_MS 10
#define TOUCH_POLL_IDLE_MS 2000
/* Without an interrupt line (the SenseCAP Indicator's FT6336U: its INT is on
 * the IO expander, unwired) the task polls, every 10 ms with a finger down or
 * not. The first report of a touch is where an edge swipe begins: at 30 ms a
 * quick pull up from the bottom had moved 15 to 30 px before it was read,
 * past the 24 px edge band (gestures.edgePx), and became a drag on whatever
 * showed (2026-11-14). A 10 ms idle poll cost an animating scene about a
 * frame a second (2026-11-07) while the task could run on the render's core;
 * it is pinned to the other one now (fos_touch_start). */
#define TOUCH_POLL_NO_IRQ_MS 10
/* A touch that lands away from the edges is reported once it has been down
 * this long, or at its lift if that is sooner, at the place it is then. A
 * thumb lands tip first and rolls toward the hand as it presses: read at once
 * (10 ms), a key tap on the SenseCAP Indicator "moved" 16 to 106 px and was a
 * drag, and typing lost most of its keys (2026-11-14). One that slid sideways
 * meanwhile is a second thumb (fos_touch_glided) and is reported where it
 * began. One in the edge band is reported at once: where it began decides an
 * edge swipe. */
#define TOUCH_SETTLE_MS 20
/* Wider than the contract's gestures.edgePx (24, in scene pixels), so that no
 * edge swipe is ever held back. */
#define TOUCH_EDGE_SOON_PX 32
/* Edges a render can sit on. A move coalesces into the newest move of the
 * same finger, so this is mostly downs and ups: 64 is plenty. */
#define TOUCH_QUEUE_LEN 64

typedef enum { CTRL_GT911 = 0, CTRL_FT6X36 = 1 } controller_t;
static const char *const k_controller_names[] = {"gt911", "ft6x36"};

static bool s_present = false;
static i2c_master_bus_handle_t s_bus = NULL;
/* False when the bus is somebody else's: fos_i2c.c's (the E1003's GT911
 * shares the clock's bus) or the display's (fos_display_shared_i2c_bus: the
 * Indicator's LCD expander shares it). The touch panel then adds its device
 * but never deletes the bus. */
static bool s_bus_owned = false;
static bool s_polled = false; /* no interrupt line: the task polls */
static controller_t s_controller = CTRL_GT911;
static i2c_master_dev_handle_t s_dev = NULL;
static uint8_t s_addr = 0;
static int s_x_max = 0, s_y_max = 0;
static bool s_swap = false;
static int s_mirror = 0; /* FOS_BOARD_TOUCH_MIRROR_*, after the swap */
static SemaphoreHandle_t s_irq = NULL;
static portMUX_TYPE s_queue_lock = portMUX_INITIALIZER_UNLOCKED;
static fos_touch_event_t s_queue[TOUCH_QUEUE_LEN];
static uint8_t s_head = 0, s_count = 0;
static uint32_t s_dropped = 0;
/* What is down, by track id, and where it last was (wire units). */
static uint8_t s_down_mask = 0;
/* Fingers on the glass whose press is not reported yet (TOUCH_SETTLE_MS),
 * and when each was first seen. */
static uint8_t s_settling_mask = 0;
static int64_t s_first_seen_ms[FOS_TOUCH_POINTS_MAX];
/* Where each settling finger was first seen: the glass's pixels and wire. */
static int16_t s_first_rx[FOS_TOUCH_POINTS_MAX], s_first_ry[FOS_TOUCH_POINTS_MAX];
static uint16_t s_first_x[FOS_TOUCH_POINTS_MAX], s_first_y[FOS_TOUCH_POINTS_MAX];
static int16_t s_last_rx[FOS_TOUCH_POINTS_MAX], s_last_ry[FOS_TOUCH_POINTS_MAX];
static uint16_t s_last_x[FOS_TOUCH_POINTS_MAX], s_last_y[FOS_TOUCH_POINTS_MAX];
static int s_last_raw_x = -1, s_last_raw_y = -1;
/* Each finger's passed positions (PSRAM, from fos_touch_start; NULL: moves
 * carry none) and which fingers' a queued move owns. */
static fos_touch_passed_t *s_passed = NULL;
static uint8_t s_passed_owned = 0;
static bool s_woke = false;

/* ------------------------------------------------------------- the queue */

static void enqueue(uint8_t kind, uint8_t id, uint16_t x, uint16_t y)
{
    int64_t at_ms = esp_timer_get_time() / 1000;
    portENTER_CRITICAL(&s_queue_lock);
    if (kind == FOS_TOUCH_MOVE) {
        int merge = fos_touch_move_slot(s_queue, TOUCH_QUEUE_LEN, s_head, s_count, id);
        if (merge >= 0) {
            /* Where it was goes on with the move, in `points`. */
            if (s_queue[merge].carries) fos_touch_passed_add(&s_passed[id], s_queue[merge].x, s_queue[merge].y);
            s_queue[merge].x = x;
            s_queue[merge].y = y;
            s_queue[merge].at_ms = at_ms;
            portEXIT_CRITICAL(&s_queue_lock);
            return;
        }
    }
    if (s_count == TOUCH_QUEUE_LEN) {
        s_dropped++;
        portEXIT_CRITICAL(&s_queue_lock);
        return;
    }
    fos_touch_event_t *slot = &s_queue[(s_head + s_count) % TOUCH_QUEUE_LEN];
    slot->kind = (uint8_t)kind;
    slot->id = id;
    slot->x = x;
    slot->y = y;
    slot->at_ms = at_ms;
    /* One queued move a finger owns its passed positions: another (behind a
     * press or a release of that finger) carries none. */
    uint8_t bit = (uint8_t)(1u << id);
    slot->carries = kind == FOS_TOUCH_MOVE && s_passed && id < FOS_TOUCH_POINTS_MAX && !(s_passed_owned & bit);
    if (slot->carries) {
        s_passed_owned |= bit;
        s_passed[id].count = 0;
    }
    s_count++;
    portEXIT_CRITICAL(&s_queue_lock);
    fos_client_wake_for_events();
}

static bool dequeue(fos_touch_event_t *out, fos_touch_passed_t *passed)
{
    portENTER_CRITICAL(&s_queue_lock);
    if (s_count == 0) {
        portEXIT_CRITICAL(&s_queue_lock);
        return false;
    }
    *out = s_queue[s_head];
    passed->count = 0;
    if (out->carries) {
        *passed = s_passed[out->id];
        s_passed[out->id].count = 0;
        s_passed_owned &= (uint8_t)~(1u << out->id);
    }
    s_head = (uint8_t)((s_head + 1) % TOUCH_QUEUE_LEN);
    s_count--;
    portEXIT_CRITICAL(&s_queue_lock);
    return true;
}

bool fos_touch_pending(void)
{
    return s_count > 0;
}

bool fos_touch_finger_down(void)
{
    /* A finger still settling (TOUCH_SETTLE_MS) is on the glass too: what
     * waits for no finger down must wait for its press as well. */
    return (s_down_mask | s_settling_mask) != 0;
}

/* The click of a press something takes, on e-paper, where the picture takes
 * its moment to answer: from this task, the moment the finger lands or
 * lifts, on its own core. The render task is in a render, a panel update or
 * (rendered on the server) a pull for a second or more at a time, and a
 * click that waited for it to dispatch the press came that late: a key typed
 * on the reTerminal Sticky while the last one drew clicked when the drawing
 * was done (2026-11-23). Whether the press is taken is the press map's, of
 * the picture showing (fos_client_press_taken): the plane's with a picture
 * it rendered, the runtime's after each render here. No map, no click. */
static uint8_t s_beep_held = 0, s_beeped = 0;

static bool sounds_on_touch(void)
{
    return fos_config()->touch_beep && !fos_display_is_lcd();
}

static void click(uint8_t kind, uint8_t id, int taken)
{
    fos_touch_beep_t beep = fos_touch_beep_step(kind, id, taken > 0, &s_beep_held, &s_beeped);
    if (beep == FOS_TOUCH_BEEP_NONE || !sounds_on_touch()) return;
    if (beep == FOS_TOUCH_BEEP_DOWN) fos_buzzer_click_down();
    else if (beep == FOS_TOUCH_BEEP_SECOND_DOWN) fos_buzzer_double_down();
    else if (beep == FOS_TOUCH_BEEP_UP) fos_buzzer_click_up();
}

/* An edge swipe's chirp, the same way: each finger that went down at an edge
 * (fos_touch_edge_at, not on the frame's keyboard) is watched until it is a
 * swipe (fos_touch_edge_step, the dispatcher's rule), heard at once, or a
 * drag along the edge. A swipe's lift does not click: its four clicks said
 * it. The panel's pixels: the scene's, turned. */
static fos_touch_edge_t s_edge[FOS_TOUCH_POINTS_MAX];
static int16_t s_edge_x[FOS_TOUCH_POINTS_MAX], s_edge_y[FOS_TOUCH_POINTS_MAX];

static void panel_point(uint16_t wx, uint16_t wy, int *x, int *y)
{
    *x = (int)((int64_t)fos_display_width() * wx / FOS_TOUCH_WIRE_MAX);
    *y = (int)((int64_t)fos_display_height() * wy / FOS_TOUCH_WIRE_MAX);
}

static void edge_begin(uint8_t id, uint16_t wx, uint16_t wy, int taken)
{
    int x, y;
    panel_point(wx, wy, &x, &y);
    s_edge[id] = taken == 2 ? FOS_TOUCH_EDGE_NONE
                            : fos_touch_edge_at(x, y, fos_display_width(), fos_display_height());
    s_edge_x[id] = (int16_t)x;
    s_edge_y[id] = (int16_t)y;
}

static void edge_moved(uint8_t id, uint16_t wx, uint16_t wy)
{
    if (s_edge[id] == FOS_TOUCH_EDGE_NONE) return;
    int x, y;
    panel_point(wx, wy, &x, &y);
    int step = fos_touch_edge_step(s_edge[id], x - s_edge_x[id], y - s_edge_y[id]);
    if (step == 0) return;
    if (step > 0) {
        s_beeped &= (uint8_t)~(1u << id);
        if (sounds_on_touch()) fos_buzzer_swipe(s_edge[id] != FOS_TOUCH_EDGE_TOP);
    }
    s_edge[id] = FOS_TOUCH_EDGE_NONE;
}

bool fos_touch_process_events(void)
{
    fos_touch_event_t event;
    bool any = false;
    static const char *const names[] = {FOS_EVENT_POINTER_DOWN, FOS_EVENT_POINTER_MOVE, FOS_EVENT_POINTER_UP};
    /* What is queued now and no more: what arrives while these run waits for
     * the next pass, after a frame. A JS handler takes ~14 ms on an ESP32-S3
     * and two fingers report every 10 ms, so draining until empty held the
     * render off for seconds (305 moves, 4.3 s between frames, 2026-11-08). */
    uint8_t budget = s_count;
    fos_touch_passed_t passed;
    while (budget-- > 0 && dequeue(&event, &passed)) {
        char payload[160 + 12 * FOS_TOUCH_PASSED_MAX];
        /* The wire position, the finger (pointer ids from 1: 0 is the one
         * mouse cursor), `touch`, and for a down or an up the primary
         * button, what is held after it and when the glass said so
         * (`atMs`, the clock the Nim side reads): the queue is drained
         * between renders, and a tap is timed by its own two reports, not
         * by when they were delivered (docs/events.md "Pointer"). */
        if (event.kind == FOS_TOUCH_MOVE) {
            /* And where the finger passed since the last move delivered. */
            char points[12 * FOS_TOUCH_PASSED_MAX + 16];
            if (fos_touch_passed_json(&passed, points, sizeof(points)) == 0) points[0] = '\0';
            snprintf(payload, sizeof(payload),
                     "{\"x\":%u,\"y\":%u,\"pointerId\":%u,\"pointerType\":\"touch\",\"buttons\":1%s}",
                     event.x, event.y, event.id + 1, points);
        } else {
            snprintf(payload, sizeof(payload),
                     "{\"x\":%u,\"y\":%u,\"pointerId\":%u,\"pointerType\":\"touch\",\"button\":0,\"buttons\":%d,\"atMs\":%lld}",
                     event.x, event.y, event.id + 1, event.kind == FOS_TOUCH_DOWN ? 1 : 0, (long long)event.at_ms);
        }
        /* `driver`: the glass talking. This is the render task, so the
         * runtime lock is free; fos_events.c asks for the render when a
         * gesture changed state. Its click was the touch task's (click). */
        fos_events_dispatch(FOS_ORIGIN_DRIVER, names[event.kind], payload);
        any = true;
    }
    return any;
}

/* --------------------------------------------------------- the controller */

static esp_err_t reg_read(uint16_t reg, uint8_t *buf, size_t len)
{
    uint8_t addr[2] = {(uint8_t)(reg >> 8), (uint8_t)reg};
    return i2c_master_transmit_receive(s_dev, addr, sizeof(addr), buf, len, TOUCH_I2C_TIMEOUT_MS);
}

static esp_err_t reg_write_byte(uint16_t reg, uint8_t value)
{
    uint8_t frame[3] = {(uint8_t)(reg >> 8), (uint8_t)reg, value};
    return i2c_master_transmit(s_dev, frame, sizeof(frame), TOUCH_I2C_TIMEOUT_MS);
}

/* The FocalTech controllers take one-byte register addresses. */
static esp_err_t ft_read(uint8_t reg, uint8_t *buf, size_t len)
{
    return i2c_master_transmit_receive(s_dev, &reg, 1, buf, len, TOUCH_I2C_TIMEOUT_MS);
}

static void IRAM_ATTR on_irq(void *arg)
{
    (void)arg;
    BaseType_t woke = pdFALSE;
    xSemaphoreGiveFromISR(s_irq, &woke);
    if (woke) portYIELD_FROM_ISR();
}

/* The GT911's address is chosen by the level of INT while RST rises: low
 * for 0x5d (0xBA/0xBB), high for 0x14 (0x28/0x29). INT then stays low for
 * Goodix's 50 ms sync before it is let go: the controller owns the line from
 * there. The bus has to be up first, so SDA and SCL are not floating while
 * the controller starts. */
static void reset_controller(const fos_touch_pins_t *pins)
{
    if (pins->irq >= 0) {
        gpio_set_direction((gpio_num_t)pins->irq, GPIO_MODE_OUTPUT);
        gpio_set_level((gpio_num_t)pins->irq, 0);
    }
    if (pins->rst >= 0) {
        gpio_set_direction((gpio_num_t)pins->rst, GPIO_MODE_OUTPUT);
        gpio_set_level((gpio_num_t)pins->rst, 0);
        vTaskDelay(pdMS_TO_TICKS(20));
        gpio_set_level((gpio_num_t)pins->rst, 1);
        vTaskDelay(pdMS_TO_TICKS(20));
    }
    if (pins->irq >= 0) {
        vTaskDelay(pdMS_TO_TICKS(50));
        gpio_set_direction((gpio_num_t)pins->irq, GPIO_MODE_INPUT);
        gpio_set_pull_mode((gpio_num_t)pins->irq, GPIO_FLOATING);
    }
    vTaskDelay(pdMS_TO_TICKS(80));
}

static bool attach(uint8_t addr, uint32_t hz)
{
    if (s_dev) {
        i2c_master_bus_rm_device(s_dev);
        s_dev = NULL;
    }
    i2c_device_config_t dev_config = {
        .dev_addr_length = I2C_ADDR_BIT_LEN_7,
        .device_address = addr,
        .scl_speed_hz = hz,
    };
    return i2c_master_bus_add_device(s_bus, &dev_config, &s_dev) == ESP_OK;
}

static bool probe_gt911(uint8_t addr)
{
    if (!attach(addr, TOUCH_GT911_I2C_HZ)) return false;
    uint8_t id[4] = {0};
    if (reg_read(FOS_TOUCH_REG_PRODUCT_ID, id, sizeof(id)) != ESP_OK) return false;
    /* "911" from a GT911; a GT9xx cousin still speaks the same report. */
    return id[0] == '9';
}

static bool probe_ft(uint8_t addr)
{
    if (!attach(addr, TOUCH_I2C_HZ)) return false;
    /* Any FocalTech answers its touch-count register; an empty address does not. */
    uint8_t count = 0;
    return ft_read(FOS_TOUCH_FT_REG_TOUCHES, &count, 1) == ESP_OK;
}

/* One report from whichever controller is there: the fingers down. */
static int read_points(fos_touch_point_t *points)
{
    if (s_controller == CTRL_FT6X36) {
        uint8_t report[FOS_TOUCH_FT_REPORT_BYTES];
        if (ft_read(FOS_TOUCH_FT_REG_TOUCHES, report, sizeof(report)) != ESP_OK) return -1;
        return fos_touch_decode_ft(report, sizeof(report), points, FOS_TOUCH_POINTS_MAX);
    }
    uint8_t report[FOS_TOUCH_REPORT_BYTES];
    if (reg_read(FOS_TOUCH_REG_STATUS, report, sizeof(report)) != ESP_OK) return -1;
    int count = fos_touch_decode(report, sizeof(report), points, FOS_TOUCH_POINTS_MAX);
    /* Every ready report is cleared, one that does not decode too: left set,
     * the controller sends no other. */
    if (report[0] & FOS_TOUCH_STATUS_READY) reg_write_byte(FOS_TOUCH_REG_STATUS, 0);
    return count;
}

static void report_down(uint8_t id, uint16_t wx, uint16_t wy)
{
    /* Where the finger landed first, then that it did, as the Linux evdev
     * translator does (translate.nim flushSlots): a scene that follows the
     * pointer by its moves (the Touch test's `mouseMove`) sees a tap where it
     * was, not only a finger dragged. */
    enqueue(FOS_TOUCH_MOVE, id, wx, wy);
    enqueue(FOS_TOUCH_DOWN, id, wx, wy);
    int taken = fos_client_press_taken(wx, wy);
    click(FOS_TOUCH_DOWN, id, taken);
    edge_begin(id, wx, wy, taken);
}

/* A press reported once it settled, where it is then; or, when it glided
 * sideways meanwhile (fos_touch_glided: a second thumb), where it began and
 * then a move to where it is. */
static void report_settled(uint8_t id, int x_max)
{
    if (fos_touch_glided(s_last_rx[id] - s_first_rx[id], s_last_ry[id] - s_first_ry[id], x_max)) {
        report_down(id, s_first_x[id], s_first_y[id]);
        enqueue(FOS_TOUCH_MOVE, id, s_last_x[id], s_last_y[id]);
        edge_moved(id, s_last_x[id], s_last_y[id]);
    } else {
        report_down(id, s_last_x[id], s_last_y[id]);
    }
}

static void touch_task(void *arg)
{
    (void)arg;
    fos_touch_point_t points[FOS_TOUCH_POINTS_MAX];
    while (true) {
        uint32_t wait_ms = (s_down_mask | s_settling_mask) ? TOUCH_POLL_HELD_MS
                           : s_polled                      ? TOUCH_POLL_NO_IRQ_MS
                                                           : TOUCH_POLL_IDLE_MS;
        xSemaphoreTake(s_irq, pdMS_TO_TICKS(wait_ms));
        int count = read_points(points);
        if (count < 0) continue; /* nothing new, or a failed read */
        int64_t now_ms = esp_timer_get_time() / 1000;
        uint8_t seen = 0;
        for (int i = 0; i < count; i++) {
            fos_touch_point_t *p = &points[i];
            if (p->id >= FOS_TOUCH_POINTS_MAX) continue;
            int rx = s_swap ? p->y : p->x;
            int ry = s_swap ? p->x : p->y;
            int x_max = s_swap ? s_y_max : s_x_max;
            int y_max = s_swap ? s_x_max : s_y_max;
            if (s_mirror & FOS_BOARD_TOUCH_MIRROR_X) rx = x_max - 1 - rx;
            if (s_mirror & FOS_BOARD_TOUCH_MIRROR_Y) ry = y_max - 1 - ry;
            uint16_t wx = (uint16_t)fos_touch_wire(rx, x_max);
            uint16_t wy = (uint16_t)fos_touch_wire(ry, y_max);
            s_last_raw_x = p->x;
            s_last_raw_y = p->y;
            uint8_t bit = (uint8_t)(1u << p->id);
            seen |= bit;
            bool was_down = (s_down_mask & bit) != 0;
            bool moved = wx != s_last_x[p->id] || wy != s_last_y[p->id];
            s_last_x[p->id] = wx;
            s_last_y[p->id] = wy;
            s_last_rx[p->id] = (int16_t)rx;
            s_last_ry[p->id] = (int16_t)ry;
            if (!was_down) {
                bool near_edge = rx < TOUCH_EDGE_SOON_PX || ry < TOUCH_EDGE_SOON_PX ||
                                 rx >= x_max - TOUCH_EDGE_SOON_PX || ry >= y_max - TOUCH_EDGE_SOON_PX;
                bool settling = (s_settling_mask & bit) != 0;
                if (!settling && !near_edge) {
                    s_settling_mask |= bit;
                    s_first_seen_ms[p->id] = now_ms;
                    s_first_rx[p->id] = (int16_t)rx;
                    s_first_ry[p->id] = (int16_t)ry;
                    s_first_x[p->id] = wx;
                    s_first_y[p->id] = wy;
                } else if (near_edge || now_ms - s_first_seen_ms[p->id] >= TOUCH_SETTLE_MS) {
                    /* On the glass before its press is queued: a frame
                     * rendered on the server sends what the queue holds once
                     * no finger is down (fos_client.c), and a press it took
                     * alone, its lift in the next pull, was two halves on the
                     * plane, no tap (reTerminal E1003, 2026-11-12: Start
                     * opened one time in several). */
                    s_settling_mask &= (uint8_t)~bit;
                    s_down_mask |= bit;
                    if (settling) report_settled(p->id, x_max);
                    else report_down(p->id, wx, wy);
                }
            } else if (moved) {
                enqueue(FOS_TOUCH_MOVE, p->id, wx, wy);
                edge_moved(p->id, wx, wy);
            }
        }
        /* A tap shorter than TOUCH_SETTLE_MS: its press, where it was last,
         * then its lift with the rest. */
        uint8_t quick = s_settling_mask & (uint8_t)~seen;
        for (int id = 0; id < FOS_TOUCH_POINTS_MAX; id++) {
            if (quick & (1u << id)) {
                report_settled((uint8_t)id, s_swap ? s_y_max : s_x_max);
                s_down_mask |= (uint8_t)(1u << id);
            }
        }
        s_settling_mask &= seen;
        /* Off the glass only once the lift is queued (the same reason as
         * above): whoever sees no finger down sees the gesture whole. The
         * render task is woken again then, since the lift's own wake came
         * while the finger still counted as down. */
        uint8_t lifted = s_down_mask & (uint8_t)~seen;
        for (int id = 0; id < FOS_TOUCH_POINTS_MAX; id++) {
            if (lifted & (1u << id)) {
                enqueue(FOS_TOUCH_UP, (uint8_t)id, s_last_x[id], s_last_y[id]);
                click(FOS_TOUCH_UP, (uint8_t)id, 0);
                s_edge[id] = FOS_TOUCH_EDGE_NONE;
            }
        }
        s_down_mask &= seen; /* a finger still settling is not down yet */
        if (lifted) fos_client_wake_for_events();
    }
}

static void log_line(const char *line)
{
    frameos_nim_log_hook(line);
}

static void drop_bus(void)
{
    if (s_dev) i2c_master_bus_rm_device(s_dev);
    if (s_bus && s_bus_owned) i2c_del_master_bus(s_bus);
    s_dev = NULL;
    s_bus = NULL;
    s_bus_owned = false;
}

static const char *mirror_name(void)
{
    static const char *const names[] = {"none", "x", "y", "xy"};
    return names[s_mirror & 3];
}

esp_err_t fos_touch_start(void)
{
    const fos_config_t *config = fos_config();
    const fos_touch_pins_t *pins = &config->touch_pins;
    if (pins->sda < 0 || pins->scl < 0) return ESP_ERR_NOT_FOUND;
    /* The display may already run a bus on these pins (the Indicator's LCD
     * expander, with the FT6336U next to it): join it instead of opening the
     * same two GPIOs twice. Its pins are then the display's business. */
    void *shared = NULL;
    bool share = fos_display_shared_i2c_bus(pins->sda, pins->scl, &shared) == ESP_OK && shared;
    /* A controller on a bus fos_i2c.c already runs (the reTerminal E1003's, on
     * the clock's 19/20) joins it too: a second bus on the same pins would
     * take them from the first, and its pins are that bus's, already claimed. */
    i2c_master_bus_handle_t lent = share ? NULL : fos_i2c_lend_bus(pins->sda, pins->scl);
    bool joined = share || lent;
    const int candidates[] = {joined ? -1 : pins->sda, joined ? -1 : pins->scl, pins->irq, pins->rst, pins->en};
    for (size_t i = 0; i < sizeof(candidates) / sizeof(candidates[0]); i++) {
        const char *why = candidates[i] >= 0 ? fos_config_gpio_pin_reserved(candidates[i]) : NULL;
        if (why) {
            ESP_LOGW(TAG, "touch GPIO %d refused: %s", candidates[i], why);
            return ESP_ERR_INVALID_ARG;
        }
    }
    /* Power before the bus: with the bus started first on a panel whose supply
     * had dropped, every probe timed out (a Sticky after a reset, 2026-11-09). */
    if (pins->en >= 0) {
        gpio_set_direction((gpio_num_t)pins->en, GPIO_MODE_OUTPUT);
        gpio_set_level((gpio_num_t)pins->en, 1);
        vTaskDelay(pdMS_TO_TICKS(TOUCH_POWER_SETTLE_MS));
    }
    s_bus = share ? (i2c_master_bus_handle_t)shared : lent;
    s_bus_owned = false;
    if (!s_bus) {
        /* GPIO19/20 are the ESP32-S3's USB D-/D+ pads, and the ROM leaves
         * the USB-Serial/JTAG PHY attached to them. The Sunton boards wire
         * their GT911 to exactly those two (a CH340 on UART0 for USB):
         * with the PHY still on the pads the controller answered the first
         * read and then NACKed every one after (the same failure fos_i2c.c
         * and fos_mic.c cure). Detach it once, before the bus comes up — and
         * claim the pads, so that the console does not take them back under
         * the controller (it did, and every read timed out from then on:
         * 2026-11-22). */
        fos_usb_pads_claim(pins->sda, pins->scl);
        i2c_master_bus_config_t bus_config = {
            .i2c_port = -1,
            .sda_io_num = (gpio_num_t)pins->sda,
            .scl_io_num = (gpio_num_t)pins->scl,
            .clk_source = I2C_CLK_SRC_DEFAULT,
            .glitch_ignore_cnt = 7,
            .flags = {.enable_internal_pullup = true},
        };
        esp_err_t err = i2c_new_master_bus(&bus_config, &s_bus);
        if (err != ESP_OK) {
            ESP_LOGW(TAG, "touch bus sda%d/scl%d: %s", pins->sda, pins->scl, esp_err_to_name(err));
            s_bus = NULL;
            return err;
        }
        s_bus_owned = true;
    }
    s_polled = pins->irq < 0;
    /* Who answers: the Goodix addresses first (its id register says so),
     * then the FocalTech ones. A controller with a reset line gets three
     * resets to answer, as in Seeed's demos. */
    static const uint8_t gt_addresses[] = {0x5d, 0x14};
    static const uint8_t ft_addresses[] = {0x48, 0x38};
    int attempts = pins->rst >= 0 ? 3 : 1;
    for (int attempt = 0; attempt < attempts && s_addr == 0; attempt++) {
        reset_controller(pins);
        for (size_t i = 0; i < sizeof(gt_addresses) && s_addr == 0; i++) {
            if (i2c_master_probe(s_bus, gt_addresses[i], TOUCH_I2C_TIMEOUT_MS) == ESP_OK && probe_gt911(gt_addresses[i])) {
                s_addr = gt_addresses[i];
                s_controller = CTRL_GT911;
            }
        }
        for (size_t i = 0; i < sizeof(ft_addresses) && s_addr == 0; i++) {
            if (i2c_master_probe(s_bus, ft_addresses[i], TOUCH_I2C_TIMEOUT_MS) == ESP_OK && probe_ft(ft_addresses[i])) {
                s_addr = ft_addresses[i];
                s_controller = CTRL_FT6X36;
            }
        }
    }
    if (s_addr == 0) {
        log_line("{\"event\":\"touch:error\",\"source\":\"esp32\",\"error\":\"no controller answered at 0x5d, 0x14, 0x48 or 0x38\"}");
        drop_bus();
        return ESP_ERR_NOT_FOUND;
    }
    uint8_t range[4] = {0};
    if (s_controller == CTRL_GT911 && reg_read(FOS_TOUCH_REG_X_MAX, range, sizeof(range)) == ESP_OK) {
        s_x_max = range[0] | (range[1] << 8);
        s_y_max = range[2] | (range[3] << 8);
    }
    /* A report left over from before the reset would hold the next one back. */
    if (s_controller == CTRL_GT911) reg_write_byte(FOS_TOUCH_REG_STATUS, 0);
    /* A controller with no configured range reports in the panel's. */
    if (s_x_max <= 1 || s_y_max <= 1 || s_x_max > 4096 || s_y_max > 4096) {
        s_x_max = fos_display_width();
        s_y_max = fos_display_height();
    }
    s_swap = fos_touch_axes_swapped(s_x_max, s_y_max, fos_display_width(), fos_display_height());
    s_mirror = fos_board_touch_mirror(config->hardware_preset);
    s_irq = xSemaphoreCreateBinary();
    if (!s_irq) return ESP_ERR_NO_MEM;
    if (!s_polled) {
        /* Any edge: the controller's trigger polarity is its configuration's,
         * and a poll follows either way. */
        gpio_install_isr_service(0); /* ESP_ERR_INVALID_STATE when already installed: fine */
        gpio_set_intr_type((gpio_num_t)pins->irq, GPIO_INTR_ANYEDGE);
        gpio_isr_handler_add((gpio_num_t)pins->irq, on_irq, NULL);
        gpio_intr_enable((gpio_num_t)pins->irq);
    }
    /* Core 0: on an RGB LCD core 1 is the render task's and the panel's
     * refill interrupt's (fos_client.c), and a poll every 10 ms must not
     * take turns there. Above the render task (5): a press wakes that task
     * from here, and it ran its render on this core, so the lift was read,
     * and stamped, only once the render was done: on the reTerminal Sticky a
     * quick tap on Start was a 4.5 s long press and clicked nothing
     * (2026-11-17). What this task does a poll is an I2C read and a queue. */
#if CONFIG_FREERTOS_NUMBER_OF_CORES > 1
    if (xTaskCreatePinnedToCore(touch_task, "fos_touch", 3072, NULL, 6, NULL, 0) != pdPASS) return ESP_ERR_NO_MEM;
#else
    if (xTaskCreate(touch_task, "fos_touch", 3072, NULL, 6, NULL) != pdPASS) return ESP_ERR_NO_MEM;
#endif
    /* A coalesced move's passed positions (docs/events.md "Pointer"), in
     * PSRAM: internal RAM is the Wi-Fi stack's. Without them a move carries
     * none. */
    s_passed = heap_caps_calloc(FOS_TOUCH_POINTS_MAX, sizeof(fos_touch_passed_t), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    /* What click asks a scene that runs here: the press map of every render.
     * An LCD never clicks (its picture answers at once), and an animation
     * there would make one every frame for nothing. */
    if (!fos_display_is_lcd()) frameos_nim_keep_press_map(true);
    s_present = true;
    char line[256];
    snprintf(line, sizeof(line),
             "{\"event\":\"touch:ready\",\"source\":\"esp32\",\"controller\":\"%s\",\"address\":\"0x%02x\","
             "\"xMax\":%d,\"yMax\":%d,\"swapped\":%s,\"mirrored\":\"%s\",\"polled\":%s,"
             "\"sharedBus\":%s,\"wake\":%s}",
             k_controller_names[s_controller], s_addr, s_x_max, s_y_max, s_swap ? "true" : "false",
             mirror_name(),
             s_polled ? "true" : "false", share ? "true" : "false",
             fos_touch_wake_pin() >= 0 ? "true" : "false");
    log_line(line);
    return ESP_OK;
}

bool fos_touch_present(void)
{
    return s_present;
}

int fos_touch_wake_pin(void)
{
#if SOC_PM_SUPPORT_EXT0_WAKEUP
    const fos_config_t *config = fos_config();
    if (!s_present) return -1;
    int pin = config->touch_pins.irq;
    return pin >= 0 && rtc_gpio_is_valid_gpio((gpio_num_t)pin) ? pin : -1;
#else
    return -1;
#endif
}

esp_err_t fos_touch_arm_wake(void)
{
    int pin = fos_touch_wake_pin();
    if (pin < 0) return ESP_OK;
#if SOC_PM_SUPPORT_EXT0_WAKEUP
    const fos_touch_pins_t *pins = &fos_config()->touch_pins;
    /* The controller stays powered and out of reset through the sleep, so
     * it can raise its line: the digital pads hold their level. */
    if (pins->en >= 0) gpio_hold_en((gpio_num_t)pins->en);
    if (pins->rst >= 0) gpio_hold_en((gpio_num_t)pins->rst);
    gpio_deep_sleep_hold_en();
    /* Wake on the line LEAVING its idle level, whichever that is for this
     * controller's trigger setting: read it now, arm the other. */
    int idle = gpio_get_level((gpio_num_t)pin);
    esp_err_t err = esp_sleep_enable_ext0_wakeup((gpio_num_t)pin, idle ? 0 : 1);
    if (err != ESP_OK) ESP_LOGW(TAG, "arming touch wake on GPIO %d failed: %s", pin, esp_err_to_name(err));
    return err;
#else
    return ESP_OK;
#endif
}

bool fos_touch_woke_chip(void)
{
#if SOC_PM_SUPPORT_EXT0_WAKEUP
    if (esp_sleep_get_wakeup_cause() == ESP_SLEEP_WAKEUP_EXT0) s_woke = true;
#endif
    return s_woke;
}

void fos_touch_print_status(void)
{
    const fos_touch_pins_t *pins = &fos_config()->touch_pins;
    if (pins->sda < 0 || pins->scl < 0) {
        printf("touch:       none (set touch_pins sda=3,scl=2,int=21,rst=41,en=42)\n");
        return;
    }
    if (!s_present) {
        printf("touch:       sda GPIO %d, scl GPIO %d, int GPIO %d: no controller answered\n",
               (int)pins->sda, (int)pins->scl, (int)pins->irq);
        return;
    }
    printf("touch:       %s at 0x%02x, %dx%d%s%s%s%s, int GPIO %d%s, fingers down 0x%02x, last raw %d,%d, dropped %lu\n",
           k_controller_names[s_controller], s_addr, s_x_max, s_y_max, s_swap ? " (axes swapped)" : "",
           s_mirror ? " (mirrored " : "", s_mirror ? mirror_name() : "", s_mirror ? ")" : "",
           (int)pins->irq, s_polled ? " (polled)" : "", (unsigned)s_down_mask,
           s_last_raw_x, s_last_raw_y, (unsigned long)s_dropped);
}
#endif /* ESP_PLATFORM */

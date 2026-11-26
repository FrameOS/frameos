/*
 * The capacitive touch panel: a Goodix GT911 on the Seeed reTerminal Sticky
 * (its own I2C bus, an interrupt line, a reset and a load switch), the
 * reTerminal E1003 (on the clock's bus, which fos_i2c.c lends it; an
 * interrupt line and a reset; `touch_pins`, docs/events.md "Input"), or a
 * FocalTech FT6336U on the Seeed SenseCAP Indicator (the LCD's I2C bus, no
 * interrupt line wired: the task polls it). A finger is a pointer to the
 * scene,
 * nothing more: the panel's reports become `pointerDown`, `pointerMove` and
 * `pointerUp` with the position on the contract's 0..32767 wire, and the
 * Nim dispatcher (frameos/input_state.nim, the same on every host) makes
 * the scene pixels, the `tap`, `doubleTap`, `longPress`, `swipe` and `pinch` of
 * them. No gesture is decided here.
 *
 * A touch task reads the controller when its interrupt line says a report
 * is ready and queues the edges; the render task drains the queue between
 * passes (fos_touch_process_events, next to the buttons'), so a touch made
 * while a render holds the runtime is delivered when it is free — as a tap,
 * since the dispatcher times the gesture from the delivery, which is the
 * right failure. Moves coalesce in the queue: a finger that moves while a
 * render runs costs one event.
 *
 * The report decode and the wire scaling are pure (main/tests/test_fos_touch.c).
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* The GT911 reports at most five fingers; each is eight bytes after the
 * status byte. */
#define FOS_TOUCH_POINTS_MAX 5
#define FOS_TOUCH_POINT_BYTES 8
#define FOS_TOUCH_REPORT_BYTES (1 + FOS_TOUCH_POINTS_MAX * FOS_TOUCH_POINT_BYTES)

/* The controller's registers (16-bit addresses, big-endian on the wire). */
#define FOS_TOUCH_REG_PRODUCT_ID 0x8140 /* 4 bytes, "911" NUL */
#define FOS_TOUCH_REG_X_MAX 0x8048      /* x_output_max L/H, then y_output_max L/H */
#define FOS_TOUCH_REG_STATUS 0x814E     /* bit 7: a report is ready; bits 0-3: fingers */
#define FOS_TOUCH_STATUS_READY 0x80
/* The contract's pointer wire (docs/events-contract.json `pointer.wireMax`). */
#define FOS_TOUCH_WIRE_MAX 32767

typedef struct {
    uint8_t id; /* the controller's track id, 0..4, stable while the finger is down */
    uint16_t x; /* in the controller's own output range */
    uint16_t y;
} fos_touch_point_t;

/* Decode a status byte and the point records after it (as read from
 * FOS_TOUCH_REG_STATUS onwards). Returns the number of fingers, 0 for none
 * down, -1 when the controller has no new report (the ready bit is clear) or
 * the buffer is too short for the fingers it claims. Pure. */
int fos_touch_decode(const uint8_t *report, size_t len, fos_touch_point_t *points, size_t max);

/* The FocalTech FT5x06/FT6x36 report, read from FOS_TOUCH_FT_REG_TOUCHES:
 * the finger count, then six bytes per finger — event flag and x high
 * nibble, x low, track id and y high nibble, y low, weight, area. Every read
 * is the present state (no ready bit). The FT6336U tracks two fingers; the
 * FT5x06 five. */
#define FOS_TOUCH_FT_REG_TOUCHES 0x02
#define FOS_TOUCH_FT_POINT_BYTES 6
#define FOS_TOUCH_FT_REPORT_BYTES (1 + FOS_TOUCH_POINTS_MAX * FOS_TOUCH_FT_POINT_BYTES)
/* The FT event flag (bits 7-6 of a record's first byte): a finger that just
 * lifted, or an empty record, is not down. */
#define FOS_TOUCH_FT_EVENT_UP 1
#define FOS_TOUCH_FT_EVENT_NONE 3

/* Decode an FT report as read from FOS_TOUCH_FT_REG_TOUCHES onwards: the
 * fingers down, their track ids and positions in the glass's pixels. Returns
 * the count (0 for none), -1 for a count the buffer cannot hold or past
 * FOS_TOUCH_POINTS_MAX. Pure. */
int fos_touch_decode_ft(const uint8_t *report, size_t len, fos_touch_point_t *points, size_t max);

/* The Hynitron CST92xx (the CST9217 of the Waveshare ESP32-S3-Touch-AMOLED-
 * 1.75): a read of the 16-bit register 0xD000 returns two fingers' records
 * — five bytes each, the second after two more (the finger count's byte and
 * an ack byte, 0xAB) — and the host writes 0xAB back to 0xD000 after every
 * read, so a read with no new report finds 0xAB in its first byte. A record
 * is the finger's track id (high nibble) and event (low nibble, 6 = down),
 * x high, y high, and the two low nibbles (SensorLib's TouchDrvCST92xx). */
#define FOS_TOUCH_CST92_REG_REPORT 0xD000
#define FOS_TOUCH_CST92_ACK 0xAB
#define FOS_TOUCH_CST92_POINTS_MAX 2
#define FOS_TOUCH_CST92_REPORT_BYTES (FOS_TOUCH_CST92_POINTS_MAX * 5 + 5)
#define FOS_TOUCH_CST92_EVENT_DOWN 0x06

/* Decode a CST92xx report as read from FOS_TOUCH_CST92_REG_REPORT: the
 * fingers down (0 once lifted), or -1 for no new report: the host's ack
 * still there, the all-0xFF the controller answers between reports while a
 * finger moves, or anything without the report's ack byte. Pure. */
/* While a finger is down the CST92xx reports at ~200 Hz; one that has sent
 * no report for this long has lifted, whatever its last report said. */
#define FOS_TOUCH_CST92_SILENT_LIFT_MS 150
int fos_touch_decode_cst92(const uint8_t *report, size_t len, fos_touch_point_t *points, size_t max);

/* A coordinate in 0..max-1 onto the 0..FOS_TOUCH_WIRE_MAX wire; clamped. Pure. */
int fos_touch_wire(int value, int max);

/* Whether a press that moved (dx, dy) in the glass's pixels while it settled
 * slid sideways a tenth of the glass or more, and mostly sideways: a second
 * thumb landing on a controller that tracks one point (the FT6336U glides it
 * from the first thumb to the second), not the first thumb rolling (up, at
 * most a fifth of that sideways). Such a press is reported where it began,
 * so the key under the first thumb is typed too (ui/events.nim). Pure. */
bool fos_touch_glided(int dx, int dy, int x_max);

/* Whether the controller's axes run the other way from the panel's: a
 * portrait-mounted glass reporting 480x800 under an 800x480 panel. Pure. */
bool fos_touch_axes_swapped(int touch_x_max, int touch_y_max, int panel_width, int panel_height);

/* One edge or move on its way from the touch task to the render task. */
enum { FOS_TOUCH_DOWN = 0, FOS_TOUCH_MOVE = 1, FOS_TOUCH_UP = 2 };

typedef struct {
    uint8_t kind;
    uint8_t id;
    uint16_t x; /* wire units */
    uint16_t y;
    uint8_t carries; /* a move that owns its finger's passed positions (fos_touch_passed_t) */
    int64_t at_ms; /* esp_timer, when the controller reported it */
} fos_touch_event_t;

/* Where a finger was between its last move delivered and the queued move that
 * stands for those since (docs/events.md "Pointer": a coalesced move's
 * `points`), wire units, oldest first: a drawing scene keeps every point of a
 * stroke made while it rendered. */
#define FOS_TOUCH_PASSED_MAX 32
typedef struct {
    uint8_t count;
    uint16_t xy[2 * FOS_TOUCH_PASSED_MAX];
} fos_touch_passed_t;

/* A move merged into the queued one: where that one was joins its passed
 * positions. Past FOS_TOUCH_PASSED_MAX every other one goes, from the oldest,
 * and the newest stays, so a long render keeps the stroke's shape. Pure. */
void fos_touch_passed_add(fos_touch_passed_t *passed, uint16_t x, uint16_t y);

/* The passed positions as `,"points":[x,y,...]` into `buf` (NUL-terminated):
 * its length, 0 when there are none or they do not fit. Pure. */
int fos_touch_passed_json(const fos_touch_passed_t *passed, char *buf, size_t size);

/* The queue slot a new move of finger `id` replaces: that finger's newest
 * event, when it is a move. -1 for none: its newest event is a press or a
 * release (a move must not jump over those), or it has none queued. Looks past
 * the other fingers' events, or two fingers moving at once would never merge
 * and would fill the queue during a slow render. Pure. */
int fos_touch_move_slot(const fos_touch_event_t *queue, size_t capacity, size_t head, size_t count, uint8_t id);

/* What a finger on the glass sounds like: its down and its up click when
 * something took the press, a different down for a finger added to one already
 * there. `held` and `beeped` are finger masks kept between calls. */
typedef enum {
    FOS_TOUCH_BEEP_NONE,
    FOS_TOUCH_BEEP_DOWN,
    FOS_TOUCH_BEEP_SECOND_DOWN,
    FOS_TOUCH_BEEP_UP,
} fos_touch_beep_t;
fos_touch_beep_t fos_touch_beep_step(uint8_t kind, uint8_t id, bool captured, uint8_t *held, uint8_t *beeped);

/* The dispatcher's edge swipe (frameos/input_state.nim edgeAt / edgeTravel,
 * the contract's `gestures`), for its chirp: the touch task sounds it the
 * moment a press becomes one, not when the render task delivers it. In the
 * scene's pixels (fos_touch_scene_point). */
typedef enum {
    FOS_TOUCH_EDGE_NONE = 0,
    FOS_TOUCH_EDGE_LEFT,
    FOS_TOUCH_EDGE_RIGHT,
    FOS_TOUCH_EDGE_TOP,
    FOS_TOUCH_EDGE_BOTTOM,
} fos_touch_edge_t;
/* Panel pixel (x, y) of a `width` x `height` panel as the scene's pixel and
 * the scene canvas's size, under the frame's rotation: utils/image.nim
 * panelToScenePoint, which the dispatcher's edges are in (top is the scene's
 * top, whichever way the panel is mounted). Pure. */
void fos_touch_scene_point(int x, int y, int width, int height, int rotate, int *sx, int *sy, int *sw, int *sh);
/* The edge within FOS_GESTURE_EDGE_PX of (x, y) on a `width` x `height`
 * panel, the nearest in a corner; none on a panel too small to spare four
 * edge widths across. Pure. */
fos_touch_edge_t fos_touch_edge_at(int x, int y, int width, int height);
/* The same on a round panel (fos_display_round), as the dispatcher reads it
 * (input_state.nim edgeAt): the rim, within FOS_GESTURE_EDGE_PX of the circle
 * inside the square, named for the quarter it is in. Pure. */
fos_touch_edge_t fos_touch_edge_at_round(int x, int y, int width, int height);
/* A press that began at that edge and is now (dx, dy) from where it began:
 * 1 an edge swipe (FOS_GESTURE_SWIPE_MIN_PX inward, more inward than along),
 * -1 no longer one (it went along the edge: a drag the scene gets), 0 not
 * yet one or the other. Pure. */
int fos_touch_edge_step(fos_touch_edge_t edge, int dx, int dy);

#ifdef ESP_PLATFORM
#include "esp_err.h"
/* Once at boot, after fos_config_init and the display (the panel's size
 * decides the axis mapping, and a panel may own the bus the controller sits
 * on): powers the controller, resets it, finds a GT911 at 0x5d or 0x14 or an
 * FT6x36/FT5x06 at 0x48 or 0x38 and starts the touch task. ESP_ERR_NOT_FOUND
 * without `touch_pins` or a controller that answers; the frame runs on
 * without. */
esp_err_t fos_touch_start(void);
/* The render task's: deliver the queued pointer events to the dispatcher.
 * True when any were delivered. */
bool fos_touch_process_events(void);
/* A report sits in the queue unprocessed. */
bool fos_touch_pending(void);
/* A finger is on the glass now (the touch task's last report). */
bool fos_touch_finger_down(void);
/* The touch panel is configured and answered at boot. */
bool fos_touch_present(void);
/* The interrupt line (-1 = none), for the wake log. */
int fos_touch_wake_pin(void);
/* Before a deep sleep (fos_buttons_arm_wake calls it): keep the controller
 * powered and arm its interrupt line as an ext0 wake, so a touch brings the
 * frame back like a key does. ESP_OK without a touch panel (nothing armed). */
esp_err_t fos_touch_arm_wake(void);
/* This boot was woken by the touch panel (fos_buttons_wake_boot asks). */
bool fos_touch_woke_chip(void);
/* One line for the console: the controller, its range, the last point. */
void fos_touch_print_status(void);
/* The console's `touch tap`: a finger at panel pixel (px, py) for `hold_ms`,
 * read by the touch task in place of the controller's reports, so a bench
 * times the whole of a press without a finger. */
esp_err_t fos_touch_inject(int px, int py, int hold_ms);
/* The console's `touch drag`: a finger from (x0, y0) to (x1, y1), panel
 * pixels, over `ms`, along a sine of `amp` pixels and `waves` periods across
 * it (0: straight), read at the task's own pace as the glass's reports. */
esp_err_t fos_touch_inject_drag(int x0, int y0, int x1, int y1, int ms, int amp, int waves);
/* When the last press was first seen and when it was lit on an LCD
 * (esp_timer us; 0: not). */
void fos_touch_press_times(int64_t *seen_us, int64_t *lit_us);
#endif

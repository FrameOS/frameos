/*
 * The capacitive touch panel: a Goodix GT911 on the Seeed reTerminal Sticky
 * (its own I2C bus, an interrupt line, a reset and a load switch) and the
 * reTerminal E1003 (on the clock's bus, which fos_i2c.c lends it; an
 * interrupt line and a reset). `touch_pins`, docs/events.md "Input". A
 * finger is a pointer to the scene,
 * nothing more: the panel's reports become `pointerDown`, `pointerMove` and
 * `pointerUp` with the position on the contract's 0..32767 wire, and the
 * Nim dispatcher (frameos/input_state.nim, the same on every host) makes
 * the scene pixels, the `tap`, `doubleTap`, `longPress` and `swipe` of
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

/* A coordinate in 0..max-1 onto the 0..FOS_TOUCH_WIRE_MAX wire; clamped. Pure. */
int fos_touch_wire(int value, int max);

/* Whether the controller's axes run the other way from the panel's: a
 * portrait-mounted glass reporting 480x800 under an 800x480 panel. Pure. */
bool fos_touch_axes_swapped(int touch_x_max, int touch_y_max, int panel_width, int panel_height);

#ifdef ESP_PLATFORM
#include "esp_err.h"
/* Once at boot, after fos_config_init and the display (the panel's size
 * decides the axis mapping): powers the controller, resets it, finds it at
 * 0x5d or 0x14 and starts the touch task. ESP_ERR_NOT_FOUND without
 * `touch_pins` or a controller that answers; the frame runs on without. */
esp_err_t fos_touch_start(void);
/* The render task's: deliver the queued pointer events to the dispatcher.
 * True when any were delivered. */
bool fos_touch_process_events(void);
/* A report sits in the queue unprocessed. */
bool fos_touch_pending(void);
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
#endif

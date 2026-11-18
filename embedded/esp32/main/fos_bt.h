#pragma once

/* Bluetooth LE keyboards and mice (HID over GATT), docs/events.md "Input".
 *
 * The frame is a central: it scans, connects to a HID device that is bonded
 * (or, while pairing is open, to any that advertises the HID service), pairs
 * "Just Works" and keeps the bond in NVS, reads the device's report map
 * (fos_hid_report.c) and subscribes to its input reports. A keyboard's keys
 * become `keyDown` / `keyUp` with the Linux key number (`linuxCode`): the
 * dispatcher's keyboard tables give the `code`, the `key` under the frame's
 * layout and the `textInput` (frameos/input_state.nim). A mouse is pointer 0:
 * its motion a `pointerMove` with `movementX` / `movementY`, its buttons
 * `pointerDown` / `pointerUp`, its wheels `wheel`. All of it goes through
 * fos_events_dispatch from the render task, so a frame rendered on its plane
 * relays it like a touch.
 *
 * Off unless `set bluetooth 1` or the frame page's switch, which start and
 * stop it while the frame runs. */

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

/* How long the frame page's Pair keeps the window open. */
#define FOS_BT_PAIR_SECONDS 60

/* At boot, after the config: starts the stack when `bluetooth` is on. */
esp_err_t fos_bt_start(void);
/* Bluetooth on or off while running, no restart (the frame page's switch,
 * `set bluetooth`): on starts the stack (ESP_ERR_NO_MEM and the like when it
 * cannot now), off stops it and gives its heap back; the bonds stay. Not
 * from the Bluetooth host's own task. */
esp_err_t fos_bt_set_enabled(bool on);
/* Input queued for the render task. */
bool fos_bt_pending(void);
/* The render task: what the keyboards and mice did since, to the dispatcher.
 * True when anything was delivered. */
bool fos_bt_process_events(void);
/* Connect to a new keyboard or mouse that advertises in the next `seconds`;
 * 0 closes the window. */
void fos_bt_pair(uint32_t seconds);
/* Forget every bonded device and drop their links. */
void fos_bt_forget(void);
/* Forget one ("aa:bb:cc:dd:ee:ff", as listed): its bond, its name, its link.
 * False when nothing by that address was known. */
bool fos_bt_forget_one(const char *address);
/* Called (from any task) when what the frame page shows of Bluetooth changed:
 * a device came or went, pairing opened or closed, a bond was forgotten. */
void fos_bt_set_change_hook(void (*hook)(void));
/* The frame page's facts (docs/scene-settings.md "The frame page"):
 * `,"bluetooth":{on, ready, pairing, devices: [{address, name, keyboard,
 * mouse, connected}]}` written at `buf`; its length, 0 in an image without
 * Bluetooth (no key at all: the page shows no section). */
size_t fos_bt_facts_json(char *buf, size_t cap);
/* `bt` on the console. */
void fos_bt_print_status(void);
/* A mouse is connected: the panel shows its cursor. */
bool fos_bt_mouse_connected(void);

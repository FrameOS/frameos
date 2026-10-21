// The Inky Frame's front buttons, as edges for the backend.
//
// A thin client has no dispatcher: its scene runs on the backend. So the
// board keeps the `gpio` edges it saw since its last render pull and sends
// them with the next one (POST /embedded/render), and the backend's runtime
// makes the presses out of them (`press`, `doublePress`, `longPress`,
// frameos/relayed_input.nim) exactly as an ESP32's own runtime does. All the
// board decides is when to send: once every press is decided, with no key
// down and no short press still inside its double-press window, so a double
// tap travels as one batch and is one `doublePress`. The debounce and that
// rule are the ESP32 button task's (fos_button_timing.c), on the contract's
// numbers. No SDK here: tests/test_pk_buttons.c.
#ifndef PK_BUTTONS_H
#define PK_BUTTONS_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "fos_button_timing.h"

// A-E: bits 0-4 of the Inky Frame's shift register, set while held.
#define PK_BUTTON_COUNT 5
// What the backend takes per pull (embedded_device.MAX_DEVICE_INPUT_EDGES).
#define PK_BUTTON_EDGES_MAX 32
// Past the double-press window, room for the backend's tick to deliver the
// `press` it closes.
#define PK_BUTTON_SETTLE_SLACK_MS 50
// The longest body pk_buttons_json writes.
#define PK_BUTTONS_JSON_MAX (40 + PK_BUTTON_EDGES_MAX * 64)

typedef struct {
    uint8_t index; // 0 is A
    bool down;
    bool wake;     // the press that powered the board on
    uint32_t at_ms; // the board's clock: ms since boot
} pk_button_edge_t;

typedef struct {
    fos_button_timing_t timing[PK_BUTTON_COUNT];
    pk_button_edge_t edges[PK_BUTTON_EDGES_MAX];
    size_t count;
    uint32_t dropped; // oldest edges let go when more came than a pull takes
} pk_buttons_t;

// `held` is the first look at the register. A key already down there is the
// press that woke the board: its `down` is stamped at the reset (0) and says
// `wake`, as the ESP32 stamps its wake press; its `up` comes from the polls.
void pk_buttons_init(pk_buttons_t *buttons, uint8_t held, uint32_t now_ms);

// One poll of the register. Every accepted edge is kept for the next pull;
// returns the keys that went down in this poll, a bit each, for the LEDs.
uint8_t pk_buttons_sample(pk_buttons_t *buttons, uint8_t held, uint32_t now_ms);

// A key is down or a short press is still inside its double-press window:
// what the edges mean is not decided yet. The board neither sends nor powers
// off while this holds.
bool pk_buttons_busy(const pk_buttons_t *buttons, uint32_t now_ms);
// Edges are waiting and every press they belong to is decided: send them.
bool pk_buttons_ready(const pk_buttons_t *buttons, uint32_t now_ms);

// The render pull's body, `{"nowMs":N,"edges":[{"label":"A","action":"down",
// "atMs":0,"wake":true},...]}`, oldest edge first. Returns its length (0 when
// it does not fit `cap`; PK_BUTTONS_JSON_MAX always does) and how many edges
// it carries in `*sent`.
size_t pk_buttons_json(const pk_buttons_t *buttons, uint32_t now_ms, char *dst, size_t cap, size_t *sent);

// The backend has the first `count` edges: forget them.
void pk_buttons_consume(pk_buttons_t *buttons, size_t count);

#endif // PK_BUTTONS_H

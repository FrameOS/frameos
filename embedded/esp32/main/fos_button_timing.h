/*
 * One GPIO button's timing, pure: the debounce, and the button layer the Nim
 * dispatcher makes out of the edges (docs/events-contract.json `buttons`:
 * `press`, `doublePress`, `longPress`), mirrored here so the buzzer can sound
 * each event the instant it happens, from the button task, while the render
 * task may be 30 s into a panel refresh.
 * The scene hears the dispatcher's events (frameos/input_state.nim), not
 * this module's; both read the same stamps and the same contract numbers
 * (FOS_BUTTON_*_MS in fos_events_gen.h), so what the finger hears is what
 * the scene gets. No IDF here: main/tests/test_button_timing.c runs it on a
 * laptop, and fos_buttons.c owns the GPIO, the queue and the buzzer calls.
 *
 * Debounce: the first change of level is the edge, stamped with the poll
 * that saw it; further changes within FOS_BUTTON_LOCKOUT_MS are contact
 * bounce and ignored. Until 2026.10.16 an edge needed the level settled for
 * 80 ms first, which swallowed a tap shorter than that and ate the second
 * press of a quick double tap (the release had not "settled" yet).
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

/* Changes within this many ms of an accepted edge are bounce. A tactile
 * switch settles in a few ms, rarely 20; the poll is 20 ms, so this skips
 * the one sample after an edge and trusts the next. */
#define FOS_BUTTON_LOCKOUT_MS 30

typedef enum {
    FOS_BUTTON_EDGE_NONE = 0,
    FOS_BUTTON_EDGE_PRESS,
    FOS_BUTTON_EDGE_RELEASE,
} fos_button_edge_t;

typedef struct {
    int level;              /* the last accepted level: 0 down (pulled up), 1 up */
    int64_t changed_at_ms;  /* when it was accepted; the lockout counts from here */
    bool down;              /* a press was accepted and its release has not been */
    int64_t pressed_at_ms;  /* the press edge's stamp */
    int64_t released_at_ms; /* the last release edge's stamp */
    bool tap_ended;         /* that release ended a short, single press: a double may follow */
    bool twice;             /* this press is the second of a double press: no long press */
    uint32_t seconds;       /* whole FOS_BUTTON_LONG_PRESS_MS this hold has sounded */
} fos_button_timing_t;

/* The line as first read: a key already down counts as pressed at `now_ms`
 * (fos_buttons.c moves `pressed_at_ms` to the wake click for a wake press). */
void fos_button_timing_init(fos_button_timing_t *b, int level, int64_t now_ms);

/* One poll sample. The edge accepted now, if any; the edge's stamp is
 * `now_ms` (read it back from `changed_at_ms`). */
fos_button_edge_t fos_button_timing_sample(fos_button_timing_t *b, int level, int64_t now_ms);

/* Book an accepted press at `at_ms`. True when it is the second press of a
 * double press: within FOS_BUTTON_DOUBLE_PRESS_MS of the previous short
 * press's release. The third press in a row starts over, as in the
 * dispatcher. */
bool fos_button_timing_press(fos_button_timing_t *b, int64_t at_ms);

/* The key is still down at `now_ms`: true at every whole
 * FOS_BUTTON_LONG_PRESS_MS of hold counted from the press (1 s, 2 s, ...),
 * when the buzzer counts the hold out loud. The scene hears nothing then:
 * its `longPress` comes once, with the `up`. Never for the second press of a
 * double press. One per call: a late call catches up with one. */
bool fos_button_timing_hold_tick(fos_button_timing_t *b, int64_t now_ms);

/* Book an accepted release at `at_ms`; returns how long the key was down
 * (at least 1). A short single press leaves `tap_ended` set: the dispatcher
 * makes it a `press` once FOS_BUTTON_DOUBLE_PRESS_MS pass with no second down.
 * `*long_press` (may be NULL) says whether the dispatcher makes this up a
 * `longPress`: held at least FOS_BUTTON_LONG_PRESS_MS, and not the second
 * press of a double press. */
uint32_t fos_button_timing_release(fos_button_timing_t *b, int64_t at_ms, bool *long_press);

/* The dispatcher still has something to decide about this key at `now_ms`:
 * it is down (its `up` decides a `longPress` or a short press), or its
 * last short press is inside the double-press window (a `press` or a
 * `doublePress` is coming). `slack_ms` past the window covers the tick that delivers it. */
bool fos_button_timing_busy(const fos_button_timing_t *b, int64_t now_ms, int64_t slack_ms);

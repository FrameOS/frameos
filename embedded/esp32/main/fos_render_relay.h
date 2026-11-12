/*
 * What a frame rendered on its control plane would have handed its own
 * scene, kept for the next render pull (docs/server-rendering.md "Keys, touch
 * and the schedule"). In remote mode fos_events_dispatch relays a scene event
 * from the frame's own producers here instead of to the Nim dispatcher; the
 * render task sends what is held as the body of a `POST` pull once the input
 * is decided, and the plane runs it through its dispatcher in the same render.
 *
 * Pure and IDF-free (tests/test_fos_render_relay.c), and not locked: the one
 * relay lives in fos_client.c, which takes a mutex around every call (the
 * producers run on the render, HTTP, cloud and button tasks).
 *
 * Each event is kept as it goes on the wire, `{"origin","name","payload"}`,
 * in order. At most FOS_RENDER_RELAY_MAX_EVENTS events and
 * FOS_RENDER_RELAY_MAX_BODY bytes of body; past either the oldest go. A
 * moving finger is folded to its newest position before it gets here, by
 * the touch queue, which the frame drains once the finger lifts.
 *
 * A pull takes everything held (fos_render_relay_take); once the plane has
 * answered it drops what it took (fos_render_relay_drop with `in_flight`),
 * and when it has not it sets `in_flight` back to 0: the same events go with
 * the next pull. What arrives while a pull is out stays behind it either way.
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define FOS_RENDER_RELAY_MAX_EVENTS 32
/* The whole body, the `{"nowMs":…,"events":[…]}` around the events included:
 * what both planes take (the backend's MAX_DEVICE_INPUT_BYTES). */
#define FOS_RENDER_RELAY_MAX_BODY (16 * 1024)

typedef struct {
    char *events[FOS_RENDER_RELAY_MAX_EVENTS]; /* malloc'd, as on the wire */
    uint8_t count;
    uint8_t in_flight; /* the first `in_flight` went out with a pull not yet answered */
    uint16_t body;     /* the events' share of the body, a comma each */
} fos_render_relay_t;

/* Hold one event, `origin` named as the contract names it. `payload_json`
 * may be NULL or empty ({}). False when it is not held: a name with a quote
 * or a backslash, a payload that is not one JSON object, an event bigger
 * than a body, no memory. `*dropped` is how many of the oldest went to make
 * room. */
bool fos_render_relay_add(fos_render_relay_t *relay, const char *origin, const char *name,
                          const char *payload_json, unsigned *dropped);

/* The body of a pull, `{"nowMs":<now_ms>,"events":[…]}`, malloc'd and
 * NUL-terminated, its length in `*len`; everything held is now in flight.
 * NULL when nothing is held or there is no memory. */
char *fos_render_relay_take(fos_render_relay_t *relay, int64_t now_ms, size_t *len);

/* Forget the `n` oldest: a pull's that the plane answered (`in_flight`), or
 * everything (`count`). `in_flight` shrinks by as many. */
void fos_render_relay_drop(fos_render_relay_t *relay, unsigned n);

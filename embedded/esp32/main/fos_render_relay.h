/*
 * What a frame rendered on its control plane would have handed its own
 * scene, kept for the next render pull (docs/server-rendering.md "Keys, touch
 * and the schedule"). In remote mode fos_events_dispatch relays a scene event
 * from the frame's own producers (`driver`, `schedule`, `http:write`,
 * `http:admin`) here instead of to the Nim dispatcher; the render task sends
 * what is held as the body of a `POST` pull once the input is decided, and
 * the plane runs it through its dispatcher in the same render.
 *
 * Pure and IDF-free (tests/test_fos_render_relay.c), and not locked: the one
 * relay lives in fos_client.c, which takes a mutex around every call (the
 * producers run on the render, HTTP, cloud and button tasks).
 *
 * In order, each event as the dispatcher would have been handed it: origin,
 * name and payload (a JSON object, its `atMs` on the board's monotonic clock).
 * A run of one name whose contract says `coalesce: latest` (a moving finger)
 * keeps the newest. At most FOS_RENDER_RELAY_MAX_EVENTS events and
 * FOS_RENDER_RELAY_MAX_BODY bytes of body; past either the oldest go.
 *
 * A pull takes everything held (fos_render_relay_take) and, once answered,
 * commits it (a 200 or a 304: the plane ran it, the events go) or releases it
 * (no answer, a 503: the same events go with the next pull). What arrives
 * while a pull is out is kept behind it either way.
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "fos_events_gen.h"

#define FOS_RENDER_RELAY_MAX_EVENTS 32
/* The whole body, the `{"nowMs":…,"events":[…]}` around the events included:
 * what both planes take (the backend's MAX_DEVICE_INPUT_BYTES). */
#define FOS_RENDER_RELAY_MAX_BODY (16 * 1024)

typedef struct {
    fos_event_origin_t origin;
    char name[FOS_CUSTOM_EVENT_MAX_NAME_LENGTH + 1];
    char *payload; /* malloc'd JSON object text */
    size_t bytes;  /* this event's share of the body, its comma included */
} fos_render_relay_event_t;

typedef struct {
    fos_render_relay_event_t events[FOS_RENDER_RELAY_MAX_EVENTS];
    size_t count;
    /* The first `in_flight` events went out with a pull that has no answer yet. */
    size_t in_flight;
    /* The events' share of the body (each one's `bytes`). */
    size_t body_bytes;
    /* The fingers (pointerId 0..31) whose `pointerDown` was relayed and whose
     * `pointerUp` / `pointerCancel` was not: a gesture still being made. */
    uint32_t pointers_down;
} fos_render_relay_t;

typedef enum {
    FOS_RENDER_RELAY_KEPT,      /* held, at the end */
    FOS_RENDER_RELAY_COALESCED, /* replaced the newest held one of its name */
    FOS_RENDER_RELAY_REFUSED,   /* not held: no name, a name that is not plain
                                 * text, a payload that is not one JSON object,
                                 * an event bigger than a body, no memory */
} fos_render_relay_result_t;

/* Hold one event. `payload_json` may be NULL or empty ({}). `*dropped` (may be
 * NULL) is how many of the oldest went to make room. */
fos_render_relay_result_t fos_render_relay_add(fos_render_relay_t *relay, fos_event_origin_t origin,
                                               const char *name, const char *payload_json,
                                               size_t *dropped);

size_t fos_render_relay_count(const fos_render_relay_t *relay);
bool fos_render_relay_pointer_down(const fos_render_relay_t *relay);

/* The body of a pull: `{"nowMs":<now_ms>,"events":[{"origin","name","payload"},…]}`,
 * malloc'd, NUL-terminated, its length in `*len`. Everything held goes out
 * (what an earlier take left in flight too). NULL when nothing is held or
 * there is no memory. */
char *fos_render_relay_take(fos_render_relay_t *relay, int64_t now_ms, size_t *len);
/* The pull was answered: what it took is gone. */
void fos_render_relay_commit(fos_render_relay_t *relay);
/* The pull was not: what it took goes with the next one. */
void fos_render_relay_release(fos_render_relay_t *relay);

/* The oldest event, out of the relay: its origin and name copied, its payload
 * handed over (the caller frees it). False when nothing is held. For a board
 * whose plane refused it, which renders the pass itself. */
bool fos_render_relay_pop(fos_render_relay_t *relay, fos_event_origin_t *origin, char *name,
                          size_t name_len, char **payload);

/* Everything gone; returns how many events were held. */
size_t fos_render_relay_clear(fos_render_relay_t *relay);

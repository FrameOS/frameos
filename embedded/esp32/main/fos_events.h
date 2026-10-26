/*
 * The firmware's one entry point for scene events.
 *
 * Every producer — the HTTP /event/<name> route, the schedule, the cloud
 * verbs, the serial console, the GPIO buttons — says WHO it is (its origin,
 * docs/events.md) and hands the event here. What the event means is decided
 * once, in fos_events.c: the contract's allow-list (fos_events_gen.h), then
 * either the firmware's own work (a render, a scene switch, a device command)
 * or the Nim dispatcher (frameos/event_loop.nim) for everything a scene hears.
 * There used to be a switch statement per producer, and they disagreed.
 *
 * The origin is an argument, never something read from the payload: a caller
 * passes the constant of its own entry point and nothing else.
 */
#pragma once

#include "fos_events_gen.h"

typedef enum {
    FOS_EVENT_DONE,    /* carried out, or handed to the scene */
    FOS_EVENT_REFUSED, /* this origin may not say it (logged as event:refused) */
    FOS_EVENT_FAILED,  /* allowed, but it came to nothing: no runtime, no such
                        * scene id in the payload, a store that failed, a
                        * command this host does not have */
    FOS_EVENT_BUSY,    /* a scene event from another task found the render
                        * task's queue full: nothing was kept */
} fos_event_result_t;

/* Installs runtime_command() as the Nim runtime's device-command hook, so a
 * command that reaches the dispatcher there lands in the same code. Call once
 * at boot, next to fos_scenes_init() (which installs the scene-select hook). */
void fos_events_init(void);

/* Route one event. The firmware's own part (render, setCurrentScene, the
 * device commands) is done when this returns, so an HTTP caller can answer
 * 400 and a cloud verb can ack an error. The part that goes to the scene runs
 * on the render task alone: called there (touch, buttons, the schedule) it is
 * delivered before this returns; called from any other task (HTTP, the cloud,
 * the console) it is queued for the render task (fos_events_defer), and
 * FOS_EVENT_DONE means queued, as on Linux. `payload_json` may be NULL or
 * empty, meaning {}. */
fos_event_result_t fos_events_dispatch(fos_event_origin_t origin, const char *name,
                                       const char *payload_json);

/* A scene event kept for the render task. A scene's handlers are JS, and the
 * first event compiles the scene's app: QuickJS's parser needs the render
 * task's 40 KB stack, and run on the 8 KB HTTP task it overflowed into the
 * task list (the first /event/pointerMove crashed the frame, 2026-10-26).
 * Bounded; a newer event the contract coalesces (a pointer move) replaces a
 * waiting one from the same origin; false when full. The render task delivers
 * them at the start of a pass and in its idle wait
 * (fos_events_deliver_deferred, true when any were delivered) and holds the
 * deep sleep while any are waiting. */
bool fos_events_defer(fos_event_origin_t origin, const char *name, const char *payload_json);
bool fos_events_deferred_pending(void);
bool fos_events_deliver_deferred(void);

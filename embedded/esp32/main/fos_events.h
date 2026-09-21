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
    FOS_EVENT_BUSY,    /* only from fos_events_dispatch_wait(): the Nim runtime
                        * was rendering for the whole timeout, nothing was
                        * delivered */
} fos_event_result_t;

/* Installs runtime_command() as the Nim runtime's device-command hook, so a
 * command that reaches the dispatcher there lands in the same code. Call once
 * at boot, next to fos_scenes_init() (which installs the scene-select hook). */
void fos_events_init(void);

/* Route one event. Synchronous: the firmware's own part (render,
 * setCurrentScene, the device commands) is done when this returns, so an HTTP
 * caller can answer 400 and a cloud verb can ack an error. The part that goes
 * to the scene waits for the Nim runtime lock — behind a render in progress,
 * which on a large panel is a minute and more. Fine for the render task's own
 * producers (schedule, buttons) and the console; see _wait for the rest.
 * `payload_json` may be NULL or empty, meaning {}. */
fos_event_result_t fos_events_dispatch(fos_event_origin_t origin, const char *name,
                                       const char *payload_json);

/* Same, but gives up on the runtime lock after timeout_ms (-1 = wait forever,
 * 0 = try once) and answers FOS_EVENT_BUSY. For the cloud WebSocket task,
 * which must keep answering the hub while a render runs. Nothing the firmware
 * does itself ever waits, with either flavour. */
fos_event_result_t fos_events_dispatch_wait(fos_event_origin_t origin, const char *name,
                                            const char *payload_json, int timeout_ms);

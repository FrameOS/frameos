/*
 * A scene switch the backend queued for this frame: the pure decision behind
 * "activate scene X when the frame next syncs". No IDF here — fos_scenes.c
 * reads the two headers off the /embedded/scenes answer and keeps the last
 * applied id in NVS; main/tests/test_fos_scene_request.c checks the rest on a
 * laptop.
 *
 * The backend answers every scenes pull (200 and 304 alike) with
 *
 *   X-FrameOS-Scene-Request-Id:    <opaque id, new per activation>
 *   X-FrameOS-Scene-Request-Scene: <scene id>
 *
 * when the workspace activated a scene. A deep-sleeping frame is rarely awake
 * to be told directly; this is how the activation waits for it. The id makes
 * it one-shot: a frame applies a request once, so a later switch on the
 * device itself (a button, the schedule, a scene's own dispatch) is not
 * undone by the same request on every following wake.
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>

#define FOS_SCENE_REQUEST_ID_LEN 64
#define FOS_SCENE_REQUEST_SCENE_LEN 128

typedef enum {
    FOS_SCENE_REQUEST_NONE = 0, /* no request in the answer */
    FOS_SCENE_REQUEST_SEEN,     /* this request was applied before */
    FOS_SCENE_REQUEST_APPLY,    /* a new request: select its scene, remember its id */
    FOS_SCENE_REQUEST_INVALID,  /* malformed; ignored */
} fos_scene_request_decision_t;

/* `request_id` / `scene_id` are the header values as received (NULL or "" =
 * absent); `applied_id` the id last applied (NULL or "" = none). Both values
 * must fit their buffers above and carry only characters that are safe to
 * echo into a JSON log line: ids [A-Za-z0-9._:-], scene ids printable ASCII
 * without quotes or backslashes. */
fos_scene_request_decision_t fos_scene_request_decide(const char *request_id,
                                                      const char *scene_id,
                                                      const char *applied_id);

/*
 * Deploy requests the backend queued for this frame, carried by the
 * /embedded/settings pull every pass makes (fos_settings.c):
 *
 *   "requests": {
 *     "console": {"id": "<new per deploy>", "settings": [["panel", "EPD_7in5_V2"], ...]},
 *     "ota":     {"id": "<new per update request>"}
 *   }
 *
 * A deep-sleeping frame is rarely awake when someone deploys; this is how a
 * deploy waits for it. `console` is the same `set` list the USB "Apply frame
 * settings" sends (backend embedded_provisioning_plan), applied through the
 * console's own `set`; `ota` is what POST /api/action/ota does. Each id is
 * applied once (NVS remembers the last one), so a request is not repeated on
 * every following wake.
 *
 * The pure half lives here, host-tested by main/tests/test_fos_device_request.c.
 */
#pragma once

#include <stdbool.h>

#define FOS_DEVICE_REQUEST_ID_LEN 64

typedef enum {
    FOS_DEVICE_REQUEST_NONE = 0, /* no request of this kind */
    FOS_DEVICE_REQUEST_SEEN,     /* applied before */
    FOS_DEVICE_REQUEST_APPLY,    /* new: apply it, then remember its id */
    FOS_DEVICE_REQUEST_INVALID,  /* malformed id; ignored */
} fos_device_request_decision_t;

/* `request_id` as received (NULL or "" = absent), `applied_id` the last one
 * applied (NULL or "" = none). Ids are [A-Za-z0-9._:-], shorter than
 * FOS_DEVICE_REQUEST_ID_LEN. */
fos_device_request_decision_t fos_device_request_decide(const char *request_id, const char *applied_id);

/* Whether a queued console setting may be applied over the network. What
 * connects the frame to its control plane — Wi-Fi, backend URL, API key,
 * frame id, cloud enrollment — is refused: one wrong value would cut the
 * frame off from the only thing that could send the correction, leaving USB
 * as the way back. Those stay console-only. */
bool fos_device_request_console_key_allowed(const char *key);

/*
 * Cloud-managed frame client (docs/cloud-frames.md).
 *
 * Enrollment flow A: when the config holds cloud_url + claim_token and Wi-Fi
 * is connected, POST {cloud_url}/api/frames/enroll with a device-generated
 * Ed25519 public key. On success the access token / frame id / ws_path are
 * persisted in NVS and the single-use claim token is erased. A permanent
 * rejection (400, e.g. invalid_claim_token) also erases the claim token —
 * the token is dead after one use, success or failure — and the state is
 * surfaced as "error" until a fresh token is provisioned.
 *
 * NVS keys (namespace "frameos", all managed here, never printed):
 *   cloud_sk    32-byte Ed25519 seed (blob)
 *   cloud_token opaque bearer access token
 *   cloud_fid   provider frame id
 *   cloud_ws    management WebSocket path (e.g. /api/frames/ws)
 *   cloud_wsurl optional full ws(s):// WebSocket URL from enrollment,
 *               used instead of cloud_url + cloud_ws when present (dev
 *               providers whose frame hub is a separate port); held to
 *               the same transport rule as cloud_url
 *
 * When enrolled and the firmware is built with esp_websocket_client, the
 * management WebSocket session (hello / challenge / auth / ready) runs with
 * the small allowlisted verb set. Documented verbs outside the esp32 profile
 * (set_schedule, set_settings, get_logs, get_metrics,
 * notify_update_available) are acked `unsupported_verb`; anything not in the
 * protocol at all is acked `unknown_verb`. Redials use jittered exponential
 * backoff (5 s → 5 min) and three consecutive authentication rejections
 * demote the device back to standalone, keeping the device key and the last
 * pushed scenes.
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include "esp_err.h"

typedef enum {
    FOS_CLOUD_NONE = 0,  /* no cloud provider configured */
    FOS_CLOUD_PENDING,   /* claim token stored, enrollment not yet succeeded */
    FOS_CLOUD_ENROLLED,  /* access token + keypair persisted */
    FOS_CLOUD_ERROR,     /* enrollment permanently failed (claim token dead) */
} fos_cloud_state_t;

/* Start the background enrollment/WS task. Call once at boot; the task idles
 * until cloud_url (+ claim_token) exist in the config and Wi-Fi is up. */
esp_err_t fos_cloud_start(void);

#define FOS_CLOUD_TOKEN_LEN 256

fos_cloud_state_t fos_cloud_state(void);
/* "none" | "pending" | "enrolled" | "error" */
const char *fos_cloud_state_name(void);
/* Short, secret-free error detail; "" when none. */
const char *fos_cloud_last_error(void);
/* Provider-assigned frame id, "" when not enrolled. */
const char *fos_cloud_frame_id(void);
/* True while the management WebSocket is connected and past `ready`. */
bool fos_cloud_ws_connected(void);
/* Tell the provider the frame is about to deep sleep: it wakes (and redials)
 * in `wake_in_seconds`; `next_render_at` is the unix time of the next panel
 * refresh (0 = unknown, no synced clock); `wake_check` says this wake is
 * only a command check-in, not a render. Sent synchronously — call it right
 * before esp_deep_sleep. False when there is no live session. */
bool fos_cloud_announce_sleep(uint32_t wake_in_seconds, int64_t next_render_at,
                              const char *reason, bool wake_check);
/* Tell the provider the panel just got a fresh render of `scene_id` (the
 * `render` message, docs/cloud-frames.md "Previews"). The provider decides
 * whether anyone is looking and, if so, queues an `image_get` — this
 * profile keeps no snapshot files, so the message says the image is to be
 * fetched with image_get rather than asset_get. False without a session. */
bool fos_cloud_announce_render(const char *scene_id);
/* An asset job (an image_get streaming the frame's image, a card read or
 * write) is queued or running on the cloud task. A deep sleep waits for
 * these — bounded — so an image the provider asked for on this very pass is
 * delivered before the CPU halts. */
bool fos_cloud_asset_jobs_pending(void);
/* Wait (up to timeout_ms) for every log line queued for the live session,
 * and the newest metrics sample, to be handed to the socket — the cloud task
 * batches both on a 1 s tick, so a caller about to halt the CPU has to give
 * that tick a chance. Returns true when everything went out, false on
 * timeout or with no live session (telemetry queued for a dead session is
 * not deliverable anyway). Call BEFORE fos_cloud_announce_sleep: the hub
 * drops the socket on `sleep`. */
bool fos_cloud_flush_logs(uint32_t timeout_ms);
/* The enrollment-supplied ws_url override, or "" when the frame dials
 * cloud_url + ws_path (the normal case). Surfaced by `status` because a
 * leftover dev override is otherwise invisible and makes every dial fail
 * with an instant TCP reset. */
const char *fos_cloud_ws_url(void);
/* Forget that override (NVS + live copy) and go back to cloud_url + ws_path. */
void fos_cloud_clear_ws_url(void);

/* Provider REST access for device-authed routes (cloud OTA manifest and
 * download): fills the provider base URL, the provider-assigned frame id and
 * a "Bearer …" Authorization value. False unless enrolled. The token is a
 * secret — callers must only send it to `url`'s origin. */
bool fos_cloud_api_access(char *url, size_t url_len,
                          char *frame_id, size_t frame_id_len,
                          char *auth_header, size_t auth_len);

/* Is this provider URL safe to carry the claim token, the bearer token and
 * the management session? https:// always is; http:// (and the ws://
 * downgrade it implies) only for localhost, `.local`/`.localhost` names and
 * private-network literals, matching docs/cloud-link.md. On false, *reason
 * (when non-NULL) is set to a short, user-facing explanation. */
bool fos_cloud_url_transport_ok(const char *url, const char **reason);

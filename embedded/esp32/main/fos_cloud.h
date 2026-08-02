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

fos_cloud_state_t fos_cloud_state(void);
/* "none" | "pending" | "enrolled" | "error" */
const char *fos_cloud_state_name(void);
/* Short, secret-free error detail; "" when none. */
const char *fos_cloud_last_error(void);
/* Provider-assigned frame id, "" when not enrolled. */
const char *fos_cloud_frame_id(void);
/* True while the management WebSocket is connected and past `ready`. */
bool fos_cloud_ws_connected(void);

/* Is this provider URL safe to carry the claim token, the bearer token and
 * the management session? https:// always is; http:// (and the ws://
 * downgrade it implies) only for localhost, `.local`/`.localhost` names and
 * private-network literals, matching docs/cloud-link.md. On false, *reason
 * (when non-NULL) is set to a short, user-facing explanation. */
bool fos_cloud_url_transport_ok(const char *url, const char **reason);

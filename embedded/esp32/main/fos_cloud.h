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
 * management WebSocket session (hello / challenge / auth / ready) runs here;
 * this file is the TRANSPORT only — the socket, the handshake, the redial
 * backoff, log/metrics telemetry and the chunked asset streams. Every
 * provider→frame verb is handed as raw bytes to the shared Nim verb layer
 * (frameos/cloud/verbs.nim, the same code the Linux runtime runs, bound to
 * the firmware by fos_cloud_verbs.c), which owns the verb table, the scope
 * checks, the settings allowlist and every ack shape. Redials use jittered
 * exponential backoff (5 s → 5 min) and three consecutive authentication
 * rejections demote the device back to standalone, keeping the device key
 * and the last pushed scenes.
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include "esp_err.h"
#include "cJSON.h"

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

/* Internal-RAM floors for STARTING a management WebSocket session (the
 * mbedTLS side lives in PSRAM; these pay for the client's task stack, lwIP's
 * socket and pbufs). Measured against heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
 * i.e. INCLUDING the DMA reserve pool — see fos_mem.h. Shared with the
 * console's `status` line and mirrored by frontend/src/utils/frameMemory.ts;
 * change all three together. */
#define FOS_CLOUD_WS_MIN_INTERNAL_FREE (24 * 1024)
#define FOS_CLOUD_WS_MIN_INTERNAL_BLOCK (12 * 1024)

fos_cloud_state_t fos_cloud_state(void);
/* "none" | "pending" | "enrolled" | "error" */
const char *fos_cloud_state_name(void);
/* Short, secret-free error detail; "" when none. */
const char *fos_cloud_last_error(void);
/* Provider-assigned frame id, "" when not enrolled. */
const char *fos_cloud_frame_id(void);
/* True while the management WebSocket is connected and past `ready`. */
bool fos_cloud_ws_connected(void);
/* Lowest-ever free bytes on the cloud task's own stack (FreeRTOS high-water
 * mark), 0 before the task exists. Internal RAM pays for every task stack,
 * so this is how oversized stacks get found without a debugger. */
size_t fos_cloud_task_stack_free(void);
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

/* ---- for fos_cloud_verbs.c (the firmware's CloudVerbContext) ----------
 *
 * The verbs themselves are dispatched by the shared Nim verb layer; these
 * are the transport-side hooks its firmware callbacks need. Cloud task only,
 * called from inside a verb. */

/* Largest file asset_get will stream; the reference provider refuses to
 * cache anything bigger. */
#define FOS_CLOUD_ASSET_MAX_FILE_BYTES (8u * 1024u * 1024u)

typedef enum {
    FOS_CLOUD_READ_ASSET = 0, /* a file off the SD card (path = sanitized relative path) */
    FOS_CLOUD_READ_IMAGE = 1, /* the frame's rendered image as BMP */
} fos_cloud_read_kind_t;

/* asset_get / image_get were accepted: after the verb's ack goes out, stream
 * the bytes as asset_chunk frames from the cloud task. The command id is
 * attached by the verb runner (it is the raw message's, not the callback's
 * to know). One per verb. */
void fos_cloud_queue_asset_read(fos_cloud_read_kind_t kind, const char *path);
/* set_scenes was stored: emit scene_ack (carrying `checksum`) once the
 * render task's apply generation moves past `generation` and the load
 * succeeded; remember the checksum for the next hello then. */
void fos_cloud_arm_scene_ack(const char *checksum, uint32_t generation);
/* reboot / restart_runtime / a boot-time setting changed: esp_restart() after
 * a short delay so the ack still flushes over the socket. Idempotent. */
void fos_cloud_schedule_reboot(void);
/* The hello-shaped fields the transport knows — frameos_version, hardware,
 * scenes_checksum — added to `msg`. The runtime adds active_scene/states. */
void fos_cloud_add_static_state(cJSON *msg);
/* Parse a log line into the {"timestamp"?, "payload"} entry shape log_batch
 * uses; plain lines get the same wrapping the backend uploader applies. */
cJSON *fos_cloud_log_line_entry(const char *line, double timestamp);

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

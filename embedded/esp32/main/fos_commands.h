/*
 * The backend's command queue, pulled.
 *
 * A frame that deep-sleeps between renders cannot be pushed to: it is a
 * fresh boot on every wake and gone again seconds later. So the self-hosted
 * backend keeps what the workspace asked for — a scene switch, a scene
 * state, a render, a reboot, a firmware update — as a queue per frame, the
 * way FrameOS Cloud does for its socket (docs/cloud-frames.md, "Queue
 * observability"), and this module drains it over HTTP:
 *
 *   POST {backend}/api/frames/{id}/embedded/commands
 *        {frameos_version, active_scene, states, scenes_etag, settings_etag}
 *     -> {commands: [{id, type, ...}, ...], pending}
 *   POST {backend}/api/frames/{id}/embedded/commands/{command_id}/ack
 *        {ok, error?, active_scene?, states?}
 *
 * The pull runs on the render task, once per pass right after the scenes and
 * settings pulls (so a switch lands in that pass's render) and whenever the
 * backend nudges an awake frame (`POST /api/action/commands` on the local
 * HTTP server). Each command goes through the same verb handlers a cloud
 * verb takes (fos_cloud_dispatch_backend_command) and is acked by id, so the
 * backend knows applied from waiting. The ETags say what this frame holds of
 * its scenes and settings pulls: a queued deploy is acked by the backend when
 * they match what it serves, never when it was queued.
 */
#pragma once

#include <stdbool.h>

/* Pull and run whatever the backend queued. Render task only. A pull the
 * backend marks `sync` fetches the scenes and settings it holds for this
 * frame BEFORE the commands run (a switch queued behind a scenes push names
 * a scene from that push), and a scene switch takes effect before the
 * command after it runs (a state for the new scene reaches it). True when
 * at least one command ran — the caller then
 * applies a pending scene selection before rendering. False (quietly)
 * without a backend, Wi-Fi, or anything queued. */
bool fos_commands_sync(void);

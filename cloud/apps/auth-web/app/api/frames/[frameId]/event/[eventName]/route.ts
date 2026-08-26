import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { recordAuditEvent } from "../../../../../../src/lib/audit";
import { csrfResponse } from "../../../../../../src/lib/csrf";
import {
  jsonError,
  parseOptionalString,
  readJsonObject,
  requireDatabase,
} from "../../../../../../src/lib/device-flow";
import {
  enqueueFrameCommand,
  frameForAccount,
  maxScenesPayloadBytes,
  supersedePendingCommands,
} from "../../../../../../src/lib/frames";
import { deviceSceneIdForFrame } from "../../../../../../src/lib/scene-images";
import { rateLimitResponse } from "../../../../../../src/lib/rate-limit";
import { readSession } from "../../../../../../src/lib/session";

export const runtime = "nodejs";

// "Now"-events expire like the command route's verbs: a scene activation
// queued on Monday must not fire on Friday.
const eventCommandTtlMs = 5 * 60 * 1000;
const maxSceneIdChars = 256;
// Public scene-state values ride along with an activation; they are a handful
// of form fields, not a data channel.
const maxStateBytes = 16 * 1024;
const maxScenesPerUpload = 20;

// The backend's event surface, translated onto the cloud's durable command
// queue (cloud/docs/cloud-workspace-gaps.md item 4). The shared SPA posts
// /api/frames/{id}/event/<name> from the scene editor ("preview on frame"),
// the Assets panel's run-image-scene buttons and the scene control rail; in
// cloud mode those map onto queue verbs the device already speaks:
//
//   render          → render
//   setCurrentScene → set_current_scene {scene_id, state?}
//   uploadScenes    → set_scenes {scenes, checksum, scene_id?, state?}
//
// An uploadScenes push deliberately does NOT touch the frame's store-scene
// assignments: the device's scenes_checksum will differ from the assigned
// checksum afterwards, and the workspace showing "out of sync" is the truth
// about an ad-hoc preview. Anything else the backend accepts as an event
// (metrics, custom scene events) has no cloud verb yet and 404s honestly.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ frameId: string; eventName: string }> },
) {
  const csrf = csrfResponse(request);
  if (csrf) {
    return csrf;
  }
  const limited = await rateLimitResponse(request, "frames:event", {
    limit: 120,
    windowMs: 15 * 60 * 1000,
  });
  if (limited) {
    return limited;
  }
  const session = await readSession();
  if (!session?.accountId) {
    return jsonError("login_required", 401);
  }
  const { db, response } = requireDatabase();
  if (!db) {
    return response;
  }
  const { frameId, eventName } = await params;
  const frame = await frameForAccount(db, session.accountId, frameId);
  if (!frame) {
    return jsonError("invalid_frame", 404);
  }
  if (frame.status !== "active") {
    return jsonError("frame_not_active", 409);
  }

  const body = await readJsonObject(request);
  // The SPA spells it sceneId on events (backend contract); scene_id also
  // accepted so callers of the command dialect can reuse this route.
  const sceneId =
    parseOptionalString(body.sceneId) ?? parseOptionalString(body.scene_id);
  const state =
    body.state &&
    typeof body.state === "object" &&
    !Array.isArray(body.state) &&
    Buffer.byteLength(JSON.stringify(body.state), "utf8") <= maxStateBytes
      ? (body.state as Record<string, unknown>)
      : undefined;

  let type: string;
  let payload: Record<string, unknown> | undefined;
  switch (eventName) {
    case "render":
      type = "render";
      break;
    // The Metrics panel's "Request metrics" button. The device answers with a
    // metrics message the hub already stores (frame_metrics + new_metrics
    // broadcast), so mapping the event is all it takes.
    case "metrics":
      type = "get_metrics";
      break;
    case "setCurrentScene": {
      if (!sceneId || sceneId.length > maxSceneIdChars) {
        return jsonError("invalid_scene_id", 400);
      }
      type = "set_current_scene";
      // The workspace names scenes by store uuid; the device by the ids in
      // the deployed scenes.json (deviceSceneIdForFrame).
      const deviceSceneId = await deviceSceneIdForFrame(db, frame.id, sceneId);
      payload = { scene_id: deviceSceneId, ...(state ? { state } : {}) };
      break;
    }
    case "uploadScenes": {
      const scenes = body.scenes;
      if (
        !Array.isArray(scenes) ||
        scenes.length === 0 ||
        scenes.length > maxScenesPerUpload
      ) {
        return jsonError("invalid_scenes", 400);
      }
      const serialized = JSON.stringify(scenes);
      if (Buffer.byteLength(serialized, "utf8") > maxScenesPayloadBytes) {
        return jsonError("scenes_payload_too_large", 400);
      }
      // The same digest the assignment push uses (buildScenesPayloadForFrame):
      // the device stores it opaquely and echoes it in scene_ack, which is
      // how the workspace can tell this ad-hoc set apart from the assigned one.
      const checksum = createHash("sha256").update(serialized).digest("hex");
      if (sceneId && sceneId.length > maxSceneIdChars) {
        return jsonError("invalid_scene_id", 400);
      }
      type = "set_scenes";
      payload = {
        checksum,
        scenes,
        ...(sceneId ? { scene_id: sceneId } : {}),
        ...(state ? { state } : {}),
      };
      // A newer scene push of either kind makes the older one pointless.
      await supersedePendingCommands(db, frame.id, "set_scenes");
      break;
    }
    default:
      return jsonError("unsupported_event", 404);
  }

  const command = await enqueueFrameCommand(db, {
    createdByAccountId: session.accountId,
    frameId: frame.id,
    payload,
    // A preview push waits for the frame like an assignment push does: the
    // battery frames this exists for spend most of their life asleep.
    ...(type === "set_scenes" ? {} : { ttlMs: eventCommandTtlMs }),
    type,
  });

  await recordAuditEvent(db, {
    accountId: session.accountId,
    actor: {
      accountId: session.accountId,
      providerSubject: session.providerSubject,
    },
    eventType: "frame.command_sent",
    metadata: { event: eventName, type },
    target: { commandId: command?.id, frameId: frame.id },
  });

  return NextResponse.json({ command_id: command?.id, status: "queued" });
}

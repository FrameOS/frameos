import { recordAuditEvent } from "../../../../../src/lib/audit";
import { NextRequest, NextResponse } from "next/server";
import { csrfResponse } from "../../../../../src/lib/csrf";
import {
  jsonError,
  parseOptionalString,
  readJsonObject,
  requireDatabase,
} from "../../../../../src/lib/device-flow";
import {
  cloudEventRouting,
  isContractEventName,
  sceneEventCommand,
} from "../../../../../src/lib/frame-events";
import { customEventRoutingForFrame } from "../../../../../src/lib/frame-scenes";
import {
  allowedFrameCommandTypes,
  enqueueFrameCommand,
  frameContractProfile,
  frameForAccount,
  supersedePendingCommands,
} from "../../../../../src/lib/frames";
import { rateLimitResponse } from "../../../../../src/lib/rate-limit";
import { deviceSceneIdForFrame } from "../../../../../src/lib/scene-images";
import { readSession } from "../../../../../src/lib/session";

export const runtime = "nodejs";

// "Now"-commands expire fast: a reboot queued on Monday must not fire when
// the frame comes back online on Friday.
const commandTtlMs = 5 * 60 * 1000;
// An update notification is advisory — the device fetches the manifest and
// verifies the signature itself (docs/cloud-frames.md "Signed OTA") — and
// battery frames sleep for hours between connects, so it outlives the action
// TTL; installing yesterday's suggested update is correct, unlike replaying
// yesterday's reboot. Repeat clicks supersede the queued one instead of
// piling up (the verb is idempotent, N notifications = 1 check).
const updateNotifyTtlMs = 24 * 60 * 60 * 1000;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ frameId: string }> },
) {
  const csrf = csrfResponse(request);
  if (csrf) {
    return csrf;
  }
  const limited = await rateLimitResponse(request, "frames:command", {
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
  const { frameId } = await params;
  const frame = await frameForAccount(db, session.accountId, frameId);
  if (!frame) {
    return jsonError("invalid_frame", 404);
  }
  if (frame.status !== "active") {
    return jsonError("frame_not_active", 409);
  }

  const body = await readJsonObject(request);
  const type = parseOptionalString(body.type) ?? "";
  if (!allowedFrameCommandTypes.has(type)) {
    return jsonError("invalid_command", 400);
  }
  let payload: Record<string, unknown> | undefined;
  if (type === "set_current_scene") {
    const sceneId = parseOptionalString(body.scene_id);
    if (!sceneId || sceneId.length > 256) {
      return jsonError("invalid_command", 400);
    }
    // The workspace and the MCP name scenes by store uuid; the device by
    // the ids in its deployed scenes.json. Same translation as
    // /event/setCurrentScene — a uuid forwarded verbatim made the device
    // answer apply-failed while the queue said delivered.
    payload = { scene_id: await deviceSceneIdForFrame(db, frame.id, sceneId) };
  }
  let sceneEventName: string | undefined;
  if (type === "scene_event") {
    // The raw form of /event/<name>, held to the same three questions so it
    // is not a way around them: is this an event the verb carries (never a
    // device command), does this frame's FrameOS know the verb, and — for a
    // custom event — does a scene on the frame let the cloud send it. The
    // device asks the first and the last again.
    const built = sceneEventCommand(body.name, body.payload);
    if (!built.ok) {
      return jsonError(built.error, built.status);
    }
    // allowBefore: an older frame's stand-in for the event (setSceneState's
    // set_current_scene) is the event route's business — this route was
    // asked for the verb by name.
    const routed = isContractEventName(built.payload.name)
      ? cloudEventRouting(
          built.payload.name,
          frameContractProfile(frame),
          frame.frameosVersion,
          { allowBefore: false },
        )
      : await customEventRoutingForFrame(db, frame, built.payload.name);
    if (!routed.ok) {
      return jsonError(
        routed.error,
        routed.status,
        routed.error === "frame_update_required"
          ? { min_frameos_version: routed.minFrameosVersion }
          : undefined,
      );
    }
    payload = built.payload;
    sceneEventName = built.payload.name;
  }

  if (type === "notify_update_available") {
    await supersedePendingCommands(db, frame.id, type);
  }
  const command = await enqueueFrameCommand(db, {
    createdByAccountId: session.accountId,
    frameId: frame.id,
    payload,
    ttlMs: type === "notify_update_available" ? updateNotifyTtlMs : commandTtlMs,
    type,
  });

  await recordAuditEvent(db, {
    accountId: session.accountId,
    actor: {
      accountId: session.accountId,
      providerSubject: session.providerSubject,
    },
    eventType: "frame.command_sent",
    metadata: { type, ...(sceneEventName ? { event: sceneEventName } : {}) },
    target: { commandId: command?.id, frameId: frame.id },
  });

  return NextResponse.json({ command_id: command?.id, status: "queued" });
}

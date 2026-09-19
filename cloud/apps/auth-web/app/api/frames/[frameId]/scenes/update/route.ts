import { NextRequest, NextResponse } from "next/server";
import { csrfResponse } from "../../../../../../src/lib/csrf";
import {
  jsonError,
  readJsonObject,
  requireDatabase,
} from "../../../../../../src/lib/device-flow";
import { updateAssignedSceneToLatest } from "../../../../../../src/lib/frame-scenes";
import { frameForAccount } from "../../../../../../src/lib/frames";
import { rateLimitResponse } from "../../../../../../src/lib/rate-limit";
import { readSession } from "../../../../../../src/lib/session";

export const runtime = "nodejs";

// "Update to latest": move ONE assigned store scene to its newest published
// version and push — the workspace's "Update available" banner and the scene
// menu's "Update to latest". GET /scenes says when there is something to do
// (`update_available`: latest_version is ahead of assigned_version, the
// version the frame was last sent). A pinned assignment is re-pinned at the
// latest version; every other assignment, the order and every grant are kept.
// Body: {"scene_id": "<store scene uuid>", "active_scene_id"?: "<runtime id>"}
// `active_scene_id` is the scene the push should leave on screen — the
// workspace passes the active one so an update never yanks the display.
// Answers `status: "up_to_date"` without pushing when the frame was already
// sent the newest version.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ frameId: string }> },
) {
  const csrf = csrfResponse(request);
  if (csrf) {
    return csrf;
  }
  const limited = await rateLimitResponse(request, "frames:scenes", {
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
  const sceneId = body.scene_id;
  if (typeof sceneId !== "string" || !/^[0-9a-f-]{36}$/i.test(sceneId)) {
    return jsonError("invalid_scene", 400);
  }
  const activeSceneId =
    typeof body.active_scene_id === "string" &&
    body.active_scene_id.length > 0 &&
    body.active_scene_id.length <= 256
      ? body.active_scene_id
      : undefined;

  const outcome = await updateAssignedSceneToLatest(db, {
    accountId: session.accountId,
    ...(activeSceneId ? { activeSceneId } : {}),
    actor: {
      accountId: session.accountId,
      providerSubject: session.providerSubject,
    },
    frame,
    sceneId,
  });
  if (!outcome.ok) {
    return jsonError(
      outcome.failure.code,
      outcome.failure.status,
      outcome.failure.detail,
    );
  }

  return NextResponse.json({
    assigned_checksum: outcome.result.assignedChecksum,
    command_id: outcome.result.commandId ?? null,
    connected: frame.connected,
    previous_version: outcome.result.previousVersion ?? null,
    scene_version: outcome.result.sceneVersion,
    status: outcome.result.updated ? "queued" : "up_to_date",
  });
}

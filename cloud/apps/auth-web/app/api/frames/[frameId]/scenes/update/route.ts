import { NextRequest, NextResponse } from "next/server";
import { csrfResponse } from "../../../../../../src/lib/csrf";
import {
  jsonError,
  readJsonObject,
  requireDatabase,
} from "../../../../../../src/lib/device-flow";
import {
  maxScenesPerFrame,
  updateAssignedScenesToLatest,
} from "../../../../../../src/lib/frame-scenes";
import { frameForAccount } from "../../../../../../src/lib/frames";
import { rateLimitResponse } from "../../../../../../src/lib/rate-limit";
import { readSession } from "../../../../../../src/lib/session";

export const runtime = "nodejs";

// "Update to latest": move the NAMED assigned store scenes — one, or several
// for the dialog's "Update all scenes" — to their newest published versions in
// one push: the workspace's "Update available" banner and the scene menu's
// "Update to latest". No other scene moves. GET /scenes says when there is
// something to do
// (`update_available`: latest_version is ahead of assigned_version, the
// version the frame was last sent). A pinned assignment is re-pinned at the
// latest version; every other assignment, the order and every grant are kept.
// Body: {"scene_id": "<store scene uuid>", "active_scene_id"?: "<runtime id>"}
// or {"scene_ids": ["<store scene uuid>", …], "active_scene_id"?: …}.
// `active_scene_id` is the scene the push should leave on screen — the
// workspace passes the active one so an update never yanks the display.
// Answers `status: "up_to_date"` without pushing when the frame was already
// sent the newest version of every scene named. `scenes` answers per scene;
// `scene_version` / `previous_version` are the first one's (the only one's,
// for `scene_id`).
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
  const sceneIds = Array.isArray(body.scene_ids)
    ? body.scene_ids
    : [body.scene_id];
  if (
    sceneIds.length === 0 ||
    sceneIds.length > maxScenesPerFrame ||
    !sceneIds.every(
      (sceneId): sceneId is string =>
        typeof sceneId === "string" && /^[0-9a-f-]{36}$/i.test(sceneId),
    )
  ) {
    return jsonError("invalid_scene", 400);
  }
  const activeSceneId =
    typeof body.active_scene_id === "string" &&
    body.active_scene_id.length > 0 &&
    body.active_scene_id.length <= 256
      ? body.active_scene_id
      : undefined;

  const outcome = await updateAssignedScenesToLatest(db, {
    accountId: session.accountId,
    ...(activeSceneId ? { activeSceneId } : {}),
    actor: {
      accountId: session.accountId,
      providerSubject: session.providerSubject,
    },
    frame,
    sceneIds,
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
    previous_version: outcome.result.scenes[0]?.previousVersion ?? null,
    scene_version: outcome.result.scenes[0]?.sceneVersion ?? null,
    scenes: outcome.result.scenes.map((scene) => ({
      previous_version: scene.previousVersion ?? null,
      scene_id: scene.sceneId,
      scene_version: scene.sceneVersion,
      updated: scene.updated,
    })),
    status: outcome.result.updated ? "queued" : "up_to_date",
  });
}

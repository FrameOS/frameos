import { NextRequest, NextResponse } from "next/server";
import { csrfResponse } from "../../../../../../src/lib/csrf";
import {
  jsonError,
  readJsonObject,
  requireDatabase,
} from "../../../../../../src/lib/device-flow";
import {
  assignScenesToFrame,
  currentSceneAssignments,
  maxScenesPerFrame,
} from "../../../../../../src/lib/frame-scenes";
import { frameForAccount } from "../../../../../../src/lib/frames";
import { rateLimitResponse } from "../../../../../../src/lib/rate-limit";
import { readSession } from "../../../../../../src/lib/session";

export const runtime = "nodejs";

// Add ONE scene to the frame's assignments and push, keeping whatever is
// already there — the store's "Install on a frame" box. The sibling POST
// /scenes replaces the whole list; this is the same merge the chat agent's
// add_scene_to_frame tool does (src/lib/ai/tools.ts). Re-adding an assigned
// scene re-deploys it at the requested version.
// Body: {"scene_id": "...", "scene_version"?: N}
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
  const sceneVersion = body.scene_version;
  if (
    sceneVersion !== undefined &&
    sceneVersion !== null &&
    (typeof sceneVersion !== "number" ||
      !Number.isInteger(sceneVersion) ||
      sceneVersion < 1)
  ) {
    return jsonError("invalid_scene", 400);
  }
  const pinned = typeof sceneVersion === "number" ? sceneVersion : null;

  const existing = await currentSceneAssignments(db, frame.id);
  const alreadyAssigned = existing.some((entry) => entry.sceneId === sceneId);
  const requested = alreadyAssigned
    ? existing.map((entry) =>
        entry.sceneId === sceneId
          ? { sceneId, sceneVersion: pinned }
          : entry,
      )
    : [...existing, { sceneId, sceneVersion: pinned }];
  if (requested.length > maxScenesPerFrame) {
    return jsonError("too_many_scenes", 409, { max: maxScenesPerFrame });
  }

  const outcome = await assignScenesToFrame(db, {
    accountId: session.accountId,
    actor: {
      accountId: session.accountId,
      providerSubject: session.providerSubject,
    },
    frame,
    requested,
    via: "store_install",
  });
  if (!outcome.ok) {
    return jsonError(
      outcome.failure.code,
      outcome.failure.status,
      outcome.failure.detail,
    );
  }

  return NextResponse.json({
    already_assigned: alreadyAssigned,
    assigned_checksum: outcome.result.assignedChecksum,
    command_id: outcome.result.commandId,
    connected: frame.connected,
    status: "queued",
  });
}

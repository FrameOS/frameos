import { asc, eq } from "drizzle-orm";
import { frameSceneAssignments, storeScenes } from "@frameos-cloud/db";
import { NextRequest, NextResponse } from "next/server";
import { csrfResponse } from "../../../../../src/lib/csrf";
import {
  jsonError,
  readJsonObject,
  requireDatabase,
} from "../../../../../src/lib/device-flow";
import {
  assignScenesToFrame,
  maxScenesPerFrame,
  type RequestedScene,
} from "../../../../../src/lib/frame-scenes";
import { frameForAccount } from "../../../../../src/lib/frames";
import { rateLimitResponse } from "../../../../../src/lib/rate-limit";
import { readSession } from "../../../../../src/lib/session";

export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ frameId: string }> },
) {
  const limited = await rateLimitResponse(request, "frames:scenes", {
    limit: 240,
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
  const rows = await db
    .select({
      latestVersion: storeScenes.latestVersion,
      position: frameSceneAssignments.position,
      sceneId: frameSceneAssignments.sceneId,
      sceneName: storeScenes.name,
      sceneSlug: storeScenes.slug,
      sceneVersion: frameSceneAssignments.sceneVersion,
      visibility: storeScenes.visibility,
    })
    .from(frameSceneAssignments)
    .innerJoin(storeScenes, eq(storeScenes.id, frameSceneAssignments.sceneId))
    .where(eq(frameSceneAssignments.frameId, frame.id))
    .orderBy(asc(frameSceneAssignments.position));
  return NextResponse.json({
    assigned_checksum: frame.assignedChecksum,
    scenes: rows.map((row) => ({
      // The store's newest version next to the pinned one (null = follows
      // the latest at push time), so the workspace can tell when a frame's
      // copy is behind.
      latest_version: row.latestVersion,
      name: row.sceneName,
      position: row.position,
      scene_id: row.sceneId,
      scene_version: row.sceneVersion,
      slug: row.sceneSlug,
      visibility: row.visibility,
    })),
    scenes_checksum: frame.scenesChecksum,
  });
}

// Replace the frame's scene assignments and enqueue a set_scenes push.
// Body: {"scenes": [{"scene_id": "...", "scene_version"?: N}, …]} in render
// order. Safety gates, in order: the frame must be active (owner confirmed),
// every scene must be accessible to this account (own scene or public), the
// pinned version must exist, and a version carrying the store's "shell" risk
// class is refused outright — a cloud push may never carry it (the device
// refuses them independently). The risk flags checked are the PINNED
// version's, not store_scenes.risk_flags, which only mirrors the latest.
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
  if (!Array.isArray(body.scenes) || body.scenes.length > maxScenesPerFrame) {
    return jsonError("invalid_scenes", 400);
  }
  // Optional: which RUNTIME scene the push should activate — the workspace's
  // save passes the currently active scene so a deploy never yanks the
  // display to another scene. The device ignores an id that is not in the
  // payload (it then activates the first scene), so only shape is validated.
  const activeSceneId =
    typeof body.scene_id === "string" &&
    body.scene_id.length > 0 &&
    body.scene_id.length <= 256
      ? body.scene_id
      : undefined;
  const requested: RequestedScene[] = [];
  for (const entry of body.scenes) {
    if (!entry || typeof entry !== "object") {
      return jsonError("invalid_scenes", 400);
    }
    const sceneId = (entry as Record<string, unknown>).scene_id;
    const sceneVersion = (entry as Record<string, unknown>).scene_version;
    if (typeof sceneId !== "string" || !/^[0-9a-f-]{36}$/i.test(sceneId)) {
      return jsonError("invalid_scenes", 400);
    }
    // Versions start at 1; rejecting 0 and negatives here keeps "pinned" and
    // "track the latest" unambiguous all the way down to the payload build.
    if (
      sceneVersion !== undefined &&
      sceneVersion !== null &&
      (typeof sceneVersion !== "number" ||
        !Number.isInteger(sceneVersion) ||
        sceneVersion < 1)
    ) {
      return jsonError("invalid_scenes", 400);
    }
    if (requested.some((r) => r.sceneId === sceneId)) {
      return jsonError("duplicate_scene", 400);
    }
    requested.push({
      sceneId,
      sceneVersion: typeof sceneVersion === "number" ? sceneVersion : null,
    });
  }

  // Everything past validation of the wire shape — the accessibility and
  // shell-risk gates, the assignment transaction, the set_scenes push, the
  // audit event — is shared with the chat agent's add_scene_to_frame tool.
  const outcome = await assignScenesToFrame(db, {
    accountId: session.accountId,
    actor: {
      accountId: session.accountId,
      providerSubject: session.providerSubject,
    },
    frame,
    requested,
    ...(activeSceneId ? { activeSceneId } : {}),
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
    command_id: outcome.result.commandId,
    status: "queued",
  });
}

import { asc, eq, inArray } from "drizzle-orm";
import {
  frames,
  frameSceneAssignments,
  storeScenes,
} from "@frameos-cloud/db";
import { recordAuditEvent } from "../../../../../src/lib/audit";
import { NextRequest, NextResponse } from "next/server";
import { csrfResponse } from "../../../../../src/lib/csrf";
import {
  jsonError,
  readJsonObject,
  requireDatabase,
} from "../../../../../src/lib/device-flow";
import {
  buildScenesPayloadForFrame,
  enqueueFrameCommand,
  frameForAccount,
  supersedePendingCommands,
} from "../../../../../src/lib/frames";
import { rateLimitResponse } from "../../../../../src/lib/rate-limit";
import { readSession } from "../../../../../src/lib/session";

export const runtime = "nodejs";

const maxScenesPerFrame = 20;

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
// every scene must be accessible to this account (own scene or public), and
// shell-flagged scenes are refused outright — a cloud push may never carry
// the store's "shell" risk class (the device refuses them independently).
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
  const requested: { sceneId: string; sceneVersion: number | null }[] = [];
  for (const entry of body.scenes) {
    if (!entry || typeof entry !== "object") {
      return jsonError("invalid_scenes", 400);
    }
    const sceneId = (entry as Record<string, unknown>).scene_id;
    const sceneVersion = (entry as Record<string, unknown>).scene_version;
    if (typeof sceneId !== "string" || !/^[0-9a-f-]{36}$/i.test(sceneId)) {
      return jsonError("invalid_scenes", 400);
    }
    if (
      sceneVersion !== undefined &&
      sceneVersion !== null &&
      (typeof sceneVersion !== "number" || !Number.isInteger(sceneVersion))
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

  if (requested.length > 0) {
    const sceneRows = await db
      .select({
        accountId: storeScenes.accountId,
        id: storeScenes.id,
        riskFlags: storeScenes.riskFlags,
        status: storeScenes.status,
        visibility: storeScenes.visibility,
      })
      .from(storeScenes)
      .where(
        inArray(
          storeScenes.id,
          requested.map((r) => r.sceneId),
        ),
      );
    const byId = new Map(sceneRows.map((row) => [row.id, row]));
    for (const { sceneId } of requested) {
      const scene = byId.get(sceneId);
      if (!scene || scene.status !== "active") {
        return jsonError("invalid_scene", 400, { scene_id: sceneId });
      }
      const accessible =
        scene.accountId === session.accountId ||
        scene.visibility === "public";
      if (!accessible) {
        return jsonError("invalid_scene", 400, { scene_id: sceneId });
      }
      if (scene.riskFlags?.includes("shell")) {
        return jsonError("scene_not_allowed", 403, {
          reason: "shell",
          scene_id: sceneId,
        });
      }
    }
  }

  const payload = await db.transaction(async (tx) => {
    await tx
      .delete(frameSceneAssignments)
      .where(eq(frameSceneAssignments.frameId, frame.id));
    if (requested.length > 0) {
      await tx.insert(frameSceneAssignments).values(
        requested.map((entry, position) => ({
          frameId: frame.id,
          position,
          sceneId: entry.sceneId,
          sceneVersion: entry.sceneVersion,
        })),
      );
    }
    return buildScenesPayloadForFrame(tx as never, frame.id);
  });

  if ("error" in payload) {
    return jsonError(payload.error, 400);
  }

  await db
    .update(frames)
    .set({ assignedChecksum: payload.checksum, updatedAt: new Date() })
    .where(eq(frames.id, frame.id));

  await supersedePendingCommands(db, frame.id, "set_scenes");
  const command = await enqueueFrameCommand(db, {
    createdByAccountId: session.accountId,
    frameId: frame.id,
    payload: { checksum: payload.checksum, scenes: payload.scenes },
    type: "set_scenes",
  });

  await recordAuditEvent(db, {
    accountId: session.accountId,
    actor: {
      accountId: session.accountId,
      providerSubject: session.providerSubject,
    },
    eventType: "frame.scenes_assigned",
    metadata: {
      checksum: payload.checksum,
      sceneCount: requested.length,
      sceneNames: payload.sceneNames,
    },
    target: { commandId: command?.id, frameId: frame.id },
  });

  return NextResponse.json({
    assigned_checksum: payload.checksum,
    command_id: command?.id,
    status: "queued",
  });
}

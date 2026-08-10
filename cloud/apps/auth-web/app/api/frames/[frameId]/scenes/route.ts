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
  declaredServiceSettingGroups,
  enqueueFrameCommand,
  enqueueServiceSettingsRefreshIfScoped,
  frameForAccount,
  pinnedSceneVersion,
  readServiceSettingGroups,
  supersedePendingCommands,
} from "../../../../../src/lib/frames";
import { rateLimitResponse } from "../../../../../src/lib/rate-limit";
import { readSession } from "../../../../../src/lib/session";

export const runtime = "nodejs";

const maxScenesPerFrame = 20;

// buildScenesPayloadForFrame reports failure by return value; inside the
// assignment transaction that has to become a throw or the delete+insert
// commits anyway.
class PayloadBuildError extends Error {}

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

  if (requested.length > 0) {
    const sceneRows = await db
      .select({
        accountId: storeScenes.accountId,
        id: storeScenes.id,
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
    for (const { sceneId, sceneVersion } of requested) {
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
      // The version this push actually pins — not store_scenes.risk_flags,
      // which is only the latest version's flags. Otherwise "publish shell
      // v1, publish clean v2, pin v1" walks straight through this gate.
      const version = await pinnedSceneVersion(db, sceneId, sceneVersion);
      if (!version) {
        return jsonError("scene_version_missing", 400, {
          scene_id: sceneId,
          scene_version: sceneVersion,
        });
      }
      if (version.riskFlags?.includes("shell")) {
        return jsonError("scene_not_allowed", 403, {
          reason: "shell",
          scene_id: sceneId,
          scene_version: version.version,
        });
      }
    }
  }

  // All-or-nothing: committing the new assignments while failing to enqueue
  // the push would leave GET listing scenes the device was never sent, with
  // assigned_checksum still describing the old set.
  let payload: Exclude<
    Awaited<ReturnType<typeof buildScenesPayloadForFrame>>,
    { error: string }
  >;
  try {
    payload = await db.transaction(async (tx) => {
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
      const built = await buildScenesPayloadForFrame(tx, frame.id);
      if ("error" in built) {
        throw new PayloadBuildError(built.error);
      }
      return built;
    });
  } catch (error) {
    if (error instanceof PayloadBuildError) {
      return jsonError(error.message, 400);
    }
    throw error;
  }

  // Which service-settings groups (unsplash, openAI, …) these scenes declare,
  // denormalized onto the frame row while we still hold the assembled scenes.
  // The device's service-settings pull needs this on every poll, and deriving
  // it there would mean unzipping every assigned scene version (32 MiB apiece
  // at the store's cap) per request. Group NAMES only — no credential ever
  // lands in a frames row.
  const serviceSettingGroups = declaredServiceSettingGroups(payload.scenes);
  const previousGroups = readServiceSettingGroups(frame.serviceSettingGroups);
  await db
    .update(frames)
    .set({
      assignedChecksum: payload.checksum,
      serviceSettingGroups,
      updatedAt: new Date(),
    })
    .where(eq(frames.id, frame.id));

  // A scene set that declares a DIFFERENT group set changes what the device's
  // pull answers, so nudge it to re-pull. Both directions matter: a newly
  // declared group means keys the frame does not have yet (without this it
  // would render "please provide an API key" until its next `ready`), and a
  // group that fell away means keys it should stop holding — the pull deletes
  // every cloud-owned group absent from the answer. Order-insensitive compare:
  // declaredServiceSettingGroups follows scene order, so reordering the same
  // scenes must not cost a wake-up. The nudge carries no payload (the keys
  // travel over the device-authed pull only) and supersedes its own pending
  // rows, so N assignments while a frame is offline are one re-pull.
  // A NULL column counts as "declares nothing": a frame that never had the
  // column computed also never received a key, so going NULL → [] is not a
  // change worth waking it for.
  const previous = previousGroups ?? [];
  const groupsChanged =
    previous.length !== serviceSettingGroups.length ||
    !serviceSettingGroups.every((group) => previous.includes(group));

  await supersedePendingCommands(db, frame.id, "set_scenes");
  const command = await enqueueFrameCommand(db, {
    createdByAccountId: session.accountId,
    frameId: frame.id,
    payload: {
      checksum: payload.checksum,
      scenes: payload.scenes,
      ...(activeSceneId ? { scene_id: activeSceneId } : {}),
    },
    type: "set_scenes",
  });

  if (groupsChanged) {
    await enqueueServiceSettingsRefreshIfScoped(db, frame.id);
  }

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

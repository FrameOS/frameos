// Assigning store scenes to a cloud-managed frame, and pushing the result to
// the device. Extracted from app/api/frames/[frameId]/scenes/route.ts so the
// AI chat agent's add_scene_to_frame tool runs the SAME gates as the
// workspace's Save/Deploy button rather than a second, drifting copy of them:
// the accessibility check and the shell-risk refusal are load-bearing, and a
// tool that reimplemented them would be one refactor away from being the hole.
//
// The caller owns authentication (session, CSRF, rate limit) and ownership —
// pass a frame row already resolved through frameForAccount. Everything after
// that lives here.

import { asc, eq, inArray } from "drizzle-orm";
import {
  createDb,
  frames,
  frameSceneAssignments,
  storeScenes,
} from "@frameos-cloud/db";
import { recordAuditEvent } from "./audit";
import {
  buildScenesPayloadForFrame,
  declaredServiceSettingGroups,
  enqueueFrameCommand,
  enqueueServiceSettingsRefreshIfScoped,
  pinnedSceneVersion,
  readServiceSettingGroups,
  supersedePendingCommands,
} from "./frames";
import { copySceneCoversIntoFrameCache } from "./scene-images";

export const maxScenesPerFrame = 20;

type Database = ReturnType<typeof createDb>;
type FrameRow = typeof frames.$inferSelect;

export type RequestedScene = { sceneId: string; sceneVersion: number | null };

// Failures carry the wire code and HTTP status the route already returned, so
// delegating did not change a single response shape. Tools translate the same
// values into their own JSON.
export type AssignScenesFailure = {
  code: string;
  detail?: Record<string, unknown>;
  status: number;
};

export type AssignScenesSuccess = {
  assignedChecksum: string;
  commandId: string | undefined;
  sceneNames: string[];
};

export type AssignScenesOutcome =
  | { ok: true; result: AssignScenesSuccess }
  | { ok: false; failure: AssignScenesFailure };

// buildScenesPayloadForFrame reports failure by return value; inside the
// assignment transaction that has to become a throw or the delete+insert
// commits anyway.
class PayloadBuildError extends Error {}

/** The frame's current assignments, in render order — the starting point for
 *  any change that is a delta rather than a wholesale replacement. */
export async function currentSceneAssignments(
  db: Database,
  frameId: string,
): Promise<RequestedScene[]> {
  const rows = await db
    .select({
      sceneId: frameSceneAssignments.sceneId,
      sceneVersion: frameSceneAssignments.sceneVersion,
    })
    .from(frameSceneAssignments)
    .where(eq(frameSceneAssignments.frameId, frameId))
    .orderBy(asc(frameSceneAssignments.position));
  return rows.map((row) => ({
    sceneId: row.sceneId,
    sceneVersion: row.sceneVersion,
  }));
}

// Every scene must be accessible to this account (own scene or public), the
// pinned version must exist, and a version carrying the store's "shell" risk
// class is refused outright — a cloud push may never carry it (the device
// refuses them independently). The risk flags checked are the PINNED
// version's, not store_scenes.risk_flags, which only mirrors the latest.
async function checkScenesAssignable(
  db: Database,
  accountId: string,
  requested: RequestedScene[],
): Promise<AssignScenesFailure | null> {
  if (requested.length === 0) {
    return null;
  }
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
      return { code: "invalid_scene", detail: { scene_id: sceneId }, status: 400 };
    }
    const accessible =
      scene.accountId === accountId || scene.visibility === "public";
    if (!accessible) {
      return { code: "invalid_scene", detail: { scene_id: sceneId }, status: 400 };
    }
    // The version this push actually pins — not store_scenes.risk_flags,
    // which is only the latest version's flags. Otherwise "publish shell
    // v1, publish clean v2, pin v1" walks straight through this gate.
    const version = await pinnedSceneVersion(db, sceneId, sceneVersion);
    if (!version) {
      return {
        code: "scene_version_missing",
        detail: { scene_id: sceneId, scene_version: sceneVersion },
        status: 400,
      };
    }
    if (version.riskFlags?.includes("shell")) {
      return {
        code: "scene_not_allowed",
        detail: {
          reason: "shell",
          scene_id: sceneId,
          scene_version: version.version,
        },
        status: 403,
      };
    }
  }
  return null;
}

/**
 * Replace the frame's scene assignments and enqueue the set_scenes push that
 * deploys them. `requested` is the complete list in render order — this is a
 * replacement, not a merge, so a caller adding one scene passes the existing
 * assignments plus the new one (see currentSceneAssignments).
 */
export async function assignScenesToFrame(
  db: Database,
  {
    accountId,
    activeSceneId,
    actor,
    frame,
    requested,
    via,
  }: {
    accountId: string;
    // Which RUNTIME scene the push should activate — the workspace's save
    // passes the currently active scene so a deploy never yanks the display
    // to another scene. The device ignores an id that is not in the payload
    // (it then activates the first scene).
    activeSceneId?: string | undefined;
    actor: unknown;
    frame: FrameRow;
    requested: RequestedScene[];
    // Recorded on the audit event so a scene set pushed by the chat agent is
    // distinguishable from one a human deployed.
    via?: string | undefined;
  },
): Promise<AssignScenesOutcome> {
  if (frame.status !== "active") {
    return { ok: false, failure: { code: "frame_not_active", status: 409 } };
  }
  if (requested.length > maxScenesPerFrame) {
    return { ok: false, failure: { code: "invalid_scenes", status: 400 } };
  }
  const seen = new Set<string>();
  for (const entry of requested) {
    if (seen.has(entry.sceneId)) {
      return { ok: false, failure: { code: "duplicate_scene", status: 400 } };
    }
    seen.add(entry.sceneId);
  }

  const notAssignable = await checkScenesAssignable(db, accountId, requested);
  if (notAssignable) {
    return { ok: false, failure: notAssignable };
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
      return { ok: false, failure: { code: error.message, status: 400 } };
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
      // Per-scene slices of the same payload. The hub promotes this map to
      // deployed_scene_state when the device acks payload.checksum, so the
      // workspace can name the scene that is not on the frame yet.
      assignedSceneState: payload.sceneStates,
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
    createdByAccountId: accountId,
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
    accountId,
    actor,
    eventType: "frame.scenes_assigned",
    metadata: {
      checksum: payload.checksum,
      sceneCount: requested.length,
      sceneNames: payload.sceneNames,
      ...(via ? { via } : {}),
    },
    target: { commandId: command?.id, frameId: frame.id },
  });

  // Install-time cover copy: without it a freshly assigned scene's tile
  // stays blank until the device renders it and a snapshot fetch lands.
  // Cosmetic, so a failure must not fail the push that just committed.
  try {
    await copySceneCoversIntoFrameCache(db, frame.id, requested);
  } catch (error) {
    console.error("install-time scene cover copy failed", error);
  }

  return {
    ok: true,
    result: {
      assignedChecksum: payload.checksum,
      commandId: command?.id,
      sceneNames: payload.sceneNames,
    },
  };
}

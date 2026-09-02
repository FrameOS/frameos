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
  enqueueFrameCommand,
  enqueueServiceSettingsRefreshIfScoped,
  grantedServiceSettingGroupsUnion,
  grantedSettingsGroupsForAssignment,
  pinnedSceneVersion,
  readServiceSettingGroups,
  supersedePendingCommands,
  storeDeclaredSettingsGroups,
} from "./frames";
import { copySceneCoversIntoFrameCache } from "./scene-images";
import { reportError } from "./log";

export const maxScenesPerFrame = 20;

type Database = ReturnType<typeof createDb>;
type FrameRow = typeof frames.$inferSelect;

export type RequestedScene = {
  sceneId: string;
  sceneVersion: number | null;
  // The service-settings groups the owner GRANTS this scene on this frame
  // (docs/cloud-frames.md, "Service settings"). Stored as the intersection
  // with what the assigned version actually declares. Omitted: an already
  // assigned scene keeps its current grant; a NEW assignment grants nothing.
  settingsGroups?: string[] | undefined;
};

// The most groups one assignment may name. Six are deliverable today; the
// bound only stops a body from carrying a novel.
export const maxSettingsGroupsPerScene = 16;

// Narrow a caller's group list to names the device can be served at all.
// Unknown names are dropped, not refused: the SPA posts whatever the scene
// declared, and a group that has since left the deliverable list must not
// break the owner's save.
export function normalizeSettingsGroups(groups: readonly string[]): string[] {
  return readServiceSettingGroups([...groups]) ?? [];
}

// The optional `settings_groups` of one scene entry on the wire: undefined
// when absent (keep / none), the list when well-formed, false when
// malformed. Names are short identifiers; anything else in the array is a
// malformed body, not a group to silently drop.
export function readSettingsGroupsField(
  value: unknown,
): string[] | undefined | false {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length > maxSettingsGroupsPerScene) {
    return false;
  }
  if (
    !value.every(
      (group) => typeof group === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(group),
    )
  ) {
    return false;
  }
  return value as string[];
}

// The grant an assignment gets on (re)assignment. `explicit` is the
// caller's list; `existing` the row this scene had on this frame before the
// replacement (undefined when it is new). The result is always ⊆ declared:
// a grant never outruns what the version asks for, and a version that
// stopped declaring a group loses it. NULL is preserved for a legacy row
// the caller did not touch, so an unrelated save (reordering, adding a
// scene) does not silently freeze or drop a pre-grant frame's keys — that
// row keeps reading as "all it declares" until the owner posts a list.
export function resolveGrantedSettingsGroups({
  declared,
  existing,
  explicit,
}: {
  declared: readonly string[];
  existing?: { grantedSettingsGroups: unknown } | undefined;
  explicit?: readonly string[] | undefined;
}): string[] | null {
  if (explicit !== undefined) {
    return normalizeSettingsGroups(explicit).filter((group) =>
      declared.includes(group),
    );
  }
  if (!existing) {
    return [];
  }
  const kept = readServiceSettingGroups(existing.grantedSettingsGroups);
  if (kept === undefined) {
    return null;
  }
  return kept.filter((group) => declared.includes(group));
}

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
  // Store scene id → the groups it ends up granted, so a caller can tell the
  // owner what a freshly installed scene still needs.
  grantedSettingsGroups: Record<string, string[]>;
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
// Whether the device holds the scene set the assignments describe. The hub
// stores the checksum the device reports on hello / scene_ack; the workspace
// shows "out of sync" on exactly this compare. Anything else — a push that
// was never acked, a preview (uploadScenes) that replaced the set on the
// device, a frame that has not connected since the assignment — means a
// set_current_scene naming an assigned scene lands `apply-failed` on the
// device, which the queue reports as delivered.
export function frameHoldsAssignedScenes(frame: {
  assignedChecksum: string | null;
  scenesChecksum: string | null;
}): boolean {
  return (
    frame.assignedChecksum !== null &&
    frame.assignedChecksum === frame.scenesChecksum
  );
}

export type RedeployOutcome =
  | { ok: true; checksum: string; commandId: string | undefined }
  | { ok: false; error: string };

// Push the frame's CURRENT assignments again, with `activeSceneId` (a runtime
// id from the deployed scenes.json) as the payload's active scene: what
// "Activate" means for a scene the device does not hold yet. Same payload,
// checksum and ledger bookkeeping as assignScenesToFrame, minus the
// assignment rewrite; the hub promotes assigned_scene_state on ack as usual.
export async function redeployAssignedScenesToFrame(
  db: Database,
  {
    accountId,
    activeSceneId,
    frame,
    state,
  }: {
    accountId: string;
    activeSceneId: string;
    frame: FrameRow;
    state?: Record<string, unknown> | undefined;
  },
): Promise<RedeployOutcome> {
  const built = await buildScenesPayloadForFrame(db, frame.id);
  if ("error" in built) {
    return { ok: false, error: built.error };
  }
  // An unpinned assignment may have resolved to a newer version here. What
  // it declares is refreshed; what it was granted is not widened — a version
  // that starts asking for a new key does not get it until the owner says so.
  const serviceSettingGroups = await storeDeclaredSettingsGroups(
    db,
    frame.id,
    built.assignments,
  );
  const previous = readServiceSettingGroups(frame.serviceSettingGroups) ?? [];
  const groupsChanged =
    previous.length !== serviceSettingGroups.length ||
    !serviceSettingGroups.every((group) => previous.includes(group));
  await db
    .update(frames)
    .set({
      assignedChecksum: built.checksum,
      assignedSceneState: built.sceneStates,
      updatedAt: new Date(),
    })
    .where(eq(frames.id, frame.id));
  await supersedePendingCommands(db, frame.id, "set_scenes");
  const command = await enqueueFrameCommand(db, {
    createdByAccountId: accountId,
    frameId: frame.id,
    payload: {
      checksum: built.checksum,
      scenes: built.scenes,
      scene_id: activeSceneId,
      ...(state ? { state } : {}),
    },
    type: "set_scenes",
  });
  if (groupsChanged) {
    await enqueueServiceSettingsRefreshIfScoped(db, frame.id);
  }
  return { ok: true, checksum: built.checksum, commandId: command?.id };
}

export async function currentSceneAssignments(
  db: Database,
  frameId: string,
): Promise<RequestedScene[]> {
  const rows = await db
    .select({
      declaredSettingsGroups: frameSceneAssignments.declaredSettingsGroups,
      grantedSettingsGroups: frameSceneAssignments.grantedSettingsGroups,
      sceneId: frameSceneAssignments.sceneId,
      sceneVersion: frameSceneAssignments.sceneVersion,
    })
    .from(frameSceneAssignments)
    .where(eq(frameSceneAssignments.frameId, frameId))
    .orderBy(asc(frameSceneAssignments.position));
  return rows.map((row) => ({
    sceneId: row.sceneId,
    sceneVersion: row.sceneVersion,
    // The effective grant, so a caller that feeds this list back in (the
    // add route, a provisioning copy onto another frame) carries it. A row
    // from before grants existed with nothing computed yet stays "omitted",
    // which re-assignment on the same frame keeps as-is.
    ...(row.grantedSettingsGroups === null && row.declaredSettingsGroups === null
      ? {}
      : { settingsGroups: grantedSettingsGroupsForAssignment(row) }),
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
  // What every requested scene was granted, resolved inside the transaction
  // and reported to the caller — group names only.
  const grantedByScene: Record<string, string[]> = {};
  let serviceSettingGroups: string[] = [];
  try {
    payload = await db.transaction(async (tx) => {
      // The grants the scenes had on this frame before the replacement: a
      // caller that omits settings_groups for a scene keeps them.
      const existingRows = await tx
        .select({
          grantedSettingsGroups: frameSceneAssignments.grantedSettingsGroups,
          sceneId: frameSceneAssignments.sceneId,
        })
        .from(frameSceneAssignments)
        .where(eq(frameSceneAssignments.frameId, frame.id));
      const existingByScene = new Map(
        existingRows.map((row) => [row.sceneId, row]),
      );
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
      // Now that the versions are open and their declarations known, settle
      // each assignment's grant: the caller's list (∩ declared), else the
      // grant the scene already had here, else nothing.
      const settled: {
        declaredSettingsGroups: string[];
        grantedSettingsGroups: string[] | null;
      }[] = [];
      for (const assignment of built.assignments) {
        const entry = requested.find((r) => r.sceneId === assignment.sceneId);
        const granted = resolveGrantedSettingsGroups({
          declared: assignment.declaredSettingsGroups,
          existing: existingByScene.get(assignment.sceneId),
          explicit: entry?.settingsGroups,
        });
        await tx
          .update(frameSceneAssignments)
          .set({
            declaredSettingsGroups: assignment.declaredSettingsGroups,
            grantedSettingsGroups: granted,
          })
          .where(eq(frameSceneAssignments.id, assignment.id));
        const row = {
          declaredSettingsGroups: assignment.declaredSettingsGroups,
          grantedSettingsGroups: granted,
        };
        settled.push(row);
        grantedByScene[assignment.sceneId] =
          grantedSettingsGroupsForAssignment(row);
      }
      // Which service-settings groups (unsplash, openAI, …) the device may
      // receive: the union of the GRANTS, denormalized onto the frame row
      // while we still hold the assembled scenes. The device's pull needs
      // this on every poll, and deriving it there would mean unzipping every
      // assigned scene version (32 MiB apiece at the store's cap) per
      // request. Group NAMES only — no credential ever lands in a frames row.
      serviceSettingGroups = grantedServiceSettingGroupsUnion(settled);
      return built;
    });
  } catch (error) {
    if (error instanceof PayloadBuildError) {
      return { ok: false, failure: { code: error.message, status: 400 } };
    }
    throw error;
  }

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

  // A scene set with a DIFFERENT granted group set changes what the device's
  // pull answers, so nudge it to re-pull. Both directions matter: a newly
  // granted group means keys the frame does not have yet (without this it
  // would render "please provide an API key" until its next `ready`), and a
  // group that fell away means keys it should stop holding — the pull deletes
  // every cloud-owned group absent from the answer. Order-insensitive compare:
  // the union follows scene order, so reordering the same scenes must not
  // cost a wake-up. The nudge carries no payload (the keys
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
      // Which keys each scene may now pull — names only. This is the consent
      // record the security review asked for.
      settingsGroups: grantedByScene,
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
    reportError("frame_scenes.cover_copy_failed", error, { frameId: frame.id });
  }

  return {
    ok: true,
    result: {
      assignedChecksum: payload.checksum,
      commandId: command?.id,
      grantedSettingsGroups: grantedByScene,
      sceneNames: payload.sceneNames,
    },
  };
}

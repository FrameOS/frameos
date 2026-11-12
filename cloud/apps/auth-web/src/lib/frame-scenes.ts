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
  assignedSceneVersion,
  assignmentVersionToSend,
  buildScenesPayloadForFrame,
  enqueueFrameCommand,
  enqueueServiceSettingsRefreshIfScoped,
  frameContractProfile,
  grantedServiceSettingGroupsUnion,
  grantedSettingsGroupsForAssignment,
  pinnedSceneVersion,
  readServiceSettingGroups,
  supersedePendingCommands,
} from "./frames";
import {
  customEventRouting,
  reportedActiveSceneId,
  type CloudEventRouting,
} from "./frame-events";
import { copySceneCoversIntoFrameCache } from "./scene-images";
import { sceneEventMapsOf, type SceneEventMaps } from "./scene-event-map";
import { sceneLayoutsOf, type SceneLayouts } from "./scene-layouts";
import { reportError } from "./log";
import { esp32PushedStateMinVersion } from "./scenes-patch";
import { frameosVersionSatisfies } from "./store-versions";

// A switch waits this long for its frame, as the event route's do.
const switchCommandTtlMs = 5 * 60 * 1000;

// The first runtime scene a store scene put in this payload: every pushed
// scene is stamped with the store scene it came from (withStoreSceneOrigin).
function firstRuntimeSceneOf(scenes: readonly unknown[], storeSceneId: string): string | undefined {
  const lowered = storeSceneId.toLowerCase();
  for (const scene of scenes) {
    const { id, origin } = (scene ?? {}) as { id?: unknown; origin?: { storeSceneId?: unknown } };
    if (typeof id === "string" && typeof origin?.storeSceneId === "string" && origin.storeSceneId.toLowerCase() === lowered) {
      return id;
    }
  }
  return undefined;
}

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
  // Move an UNPINNED assignment to the newest published version on this push:
  // an explicit update, a re-install, the workspace saving its own edit.
  // Without it an unpinned assignment the frame already has is sent again at
  // the version the frame holds — every push carries the whole set, so
  // anything else updates every scene whenever one of them changes. A scene
  // new to the frame starts at the newest version either way.
  latest?: boolean | undefined;
  // The owner's button maps for this scene on this frame, by runtime scene
  // id (scene-event-map.ts; docs/events.md "Event map"). Omitted: an already
  // assigned scene keeps its maps (a scene update, a reorder, a grant never
  // touch them); null clears them.
  eventMaps?: SceneEventMaps | null | undefined;
  // The layout each runtime scene of this install wears (scene-layouts.ts;
  // docs/scene-layouts.md), the same way: omitted keeps, null clears.
  layouts?: SceneLayouts | null | undefined;
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

// Public scene-state values that ride along with an activation: a handful of
// form fields, not a data channel (the event route's ceiling).
export const maxActiveSceneStateBytes = 16 * 1024;

// A push's `state` for the scene it activates: undefined when absent or
// empty, false when it is not an object or is too big.
export function readActiveSceneState(
  value: unknown,
): Record<string, unknown> | undefined | false {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  if (Object.keys(value).length === 0) {
    return undefined;
  }
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > maxActiveSceneStateBytes) {
    return false;
  }
  return value as Record<string, unknown>;
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
  // Store scene id → the version this push carries (what an unpinned
  // assignment resolved to).
  sceneVersions: Record<string, number>;
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

// redeployAssignedScenesToFrame lives in frames.ts (Next-free) so the frame
// hub can call it too — a device whose scene store came up empty asks for its
// assignments back in its hello. Re-exported here for the routes that grew up
// around this module.
export {
  assignedSceneVersion,
  redeployAssignedScenesToFrame,
  type RedeployOutcome,
} from "./frames";

export async function currentSceneAssignments(
  db: Database,
  frameId: string,
): Promise<RequestedScene[]> {
  const rows = await db
    .select({
      declaredSettingsGroups: frameSceneAssignments.declaredSettingsGroups,
      eventMaps: frameSceneAssignments.eventMaps,
      grantedSettingsGroups: frameSceneAssignments.grantedSettingsGroups,
      layouts: frameSceneAssignments.layouts,
      sceneId: frameSceneAssignments.sceneId,
      sceneVersion: frameSceneAssignments.sceneVersion,
    })
    .from(frameSceneAssignments)
    .where(eq(frameSceneAssignments.frameId, frameId))
    .orderBy(asc(frameSceneAssignments.position));
  return rows.map((row) => ({
    sceneId: row.sceneId,
    sceneVersion: row.sceneVersion,
    // The owner's button maps travel with the list too (a provisioning copy
    // onto another frame keeps them); an assignment without any stays
    // "omitted", which re-assignment keeps as-is.
    ...(row.eventMaps === null ? {} : { eventMaps: sceneEventMapsOf(row.eventMaps) }),
    ...(row.layouts === null ? {} : { layouts: sceneLayoutsOf(row.layouts) }),
    // The effective grant, so a caller that feeds this list back in (the
    // add route, a provisioning copy onto another frame) carries it. A row
    // from before grants existed with nothing computed yet stays "omitted",
    // which re-assignment on the same frame keeps as-is.
    ...(row.grantedSettingsGroups === null && row.declaredSettingsGroups === null
      ? {}
      : { settingsGroups: grantedSettingsGroupsForAssignment(row) }),
  }));
}

// May the cloud send this frame the custom scene event `eventName`
// (customEventRouting, frame-events.ts)? The scenes asked are the ones a push
// to this frame would carry right now — the assignments at the versions the
// frame holds (buildScenesPayloadForFrame) — because `customEvents` lives in
// each version's scenes.json and nowhere else. A set that cannot be assembled
// (a pulled scene, a yanked version) declares nothing. That reads every
// assigned scene's blob, which is fine for an event somebody pressed a button
// for: both routes that call this are rate limited, and contract events never
// come here.
export async function customEventRoutingForFrame(
  db: Database,
  frame: {
    id: string;
    hardware: unknown;
    frameosVersion: string | null;
    lastState: unknown;
  },
  eventName: string,
): Promise<CloudEventRouting> {
  const built = await buildScenesPayloadForFrame(db, frame.id);
  return customEventRouting({
    activeSceneId: reportedActiveSceneId(frame.lastState),
    eventName,
    frameosVersion: frame.frameosVersion,
    profile: frameContractProfile(frame),
    scenes: "error" in built ? [] : built.scenes,
  });
}

// Every scene must be accessible to this account (own scene or public), the
// pinned version must exist, and a version carrying the store's "shell" risk
// class is refused outright — a cloud push may never carry it (the device
// refuses them independently). The risk flags checked are the PINNED
// version's, not store_scenes.risk_flags, which only mirrors the latest.
//
// A version that declares a minimum FrameOS newer than the frame reports
// (store_scene_versions.frameos_version, from its template.json) is refused
// with frame_update_required: the frame would show nothing (a JSX scene on a
// runtime before 2026.10.21). Only a version the push MOVES the frame to is
// checked — one the frame was already sent keeps going out with every other
// push, so an old install never blocks a reorder or a grant. A frame that
// reports no version, or a version without a minimum, passes
// (frameosVersionSatisfies). Self-hosted backends get the same rule from the
// versioned store index, which lists only what their version runs.
async function checkScenesAssignable(
  db: Database,
  accountId: string,
  frame: { assignedSceneState: unknown; frameosVersion?: string | null | undefined },
  requested: RequestedScene[],
  latestSceneIds: ReadonlySet<string>,
): Promise<AssignScenesFailure | null> {
  if (requested.length === 0) {
    return null;
  }
  const sceneRows = await db
    .select({
      accountId: storeScenes.accountId,
      id: storeScenes.id,
      name: storeScenes.name,
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
    // The version this push actually carries (the pin, the held version of
    // an unpinned assignment, else the newest — the same resolution as
    // buildScenesPayloadForFrame) — not store_scenes.risk_flags, which is
    // only the latest version's flags. Otherwise "publish shell v1, publish
    // clean v2, pin v1" walks straight through this gate.
    const wanted = assignmentVersionToSend(
      frame,
      { sceneId, sceneVersion },
      latestSceneIds,
    );
    const version =
      (await pinnedSceneVersion(db, sceneId, wanted)) ??
      (sceneVersion === null && wanted !== null
        ? await pinnedSceneVersion(db, sceneId, null)
        : undefined);
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
    const alreadySent = assignedSceneVersion(frame, sceneId) === version.version;
    if (
      !alreadySent &&
      !frameosVersionSatisfies(version.frameosVersion, frame.frameosVersion)
    ) {
      return {
        code: "frame_update_required",
        detail: {
          // The sentence the workspace and the chat show as it is.
          detail: `${scene.name} needs FrameOS ${version.frameosVersion} or later, and this frame runs ${frame.frameosVersion}. Update FrameOS on the frame first.`,
          frameos_version: frame.frameosVersion,
          min_frameos_version: version.frameosVersion,
          scene_id: sceneId,
          scene_version: version.version,
        },
        status: 409,
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
    activeState,
    activateStoreSceneId,
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
    // Public field values the activated scene opens with ("Push & activate"):
    // in the same set_scenes, as uploadScenes carries them, never a second
    // command racing the push. Only with activeSceneId.
    activeState?: Record<string, unknown> | undefined;
    // Or the STORE scene to show, its first runtime scene in this push
    // ("Install & activate", the MCP install with activate): resolved from
    // the payload, so a scene installed by this very push can be named.
    activateStoreSceneId?: string | undefined;
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

  const latestSceneIds = new Set(
    requested.filter((entry) => entry.latest).map((entry) => entry.sceneId),
  );
  const notAssignable = await checkScenesAssignable(
    db,
    accountId,
    frame,
    requested,
    latestSceneIds,
  );
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
          eventMaps: frameSceneAssignments.eventMaps,
          grantedSettingsGroups: frameSceneAssignments.grantedSettingsGroups,
          layouts: frameSceneAssignments.layouts,
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
            // The owner's button maps: the caller's, else what this scene
            // had here (a scene update, a reorder or a grant never drops
            // them), else none. Written before the payload is built, which
            // reads them back onto each scene.
            eventMaps:
              entry.eventMaps !== undefined
                ? entry.eventMaps
                : sceneEventMapsOf(existingByScene.get(entry.sceneId)?.eventMaps),
            // The layouts, by the same rule.
            layouts:
              entry.layouts !== undefined
                ? entry.layouts
                : sceneLayoutsOf(existingByScene.get(entry.sceneId)?.layouts),
          })),
        );
      }
      const built = await buildScenesPayloadForFrame(tx, frame.id, {
        latestSceneIds,
      });
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
            isLayout: assignment.isLayout,
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

  // A Linux frame shows the FIRST scene of a push that names none (its
  // runner's rule), so a push nobody meant as a switch (an install, a
  // reorder, a Discard) names the scene the frame says it shows, when the
  // push still holds it. An ESP32 keeps its scene, and there a scene_id costs
  // a render: nothing is added.
  const profile = frameContractProfile(frame);
  const shown = reportedActiveSceneId(frame.lastState);
  const showSceneId =
    activeSceneId ??
    (activateStoreSceneId ? firstRuntimeSceneOf(payload.scenes, activateStoreSceneId) : undefined);
  const pushSceneId =
    showSceneId ??
    (profile === "linux" && shown && payload.scenes.some((scene) => (scene as { id?: unknown })?.id === shown)
      ? shown
      : undefined);
  await supersedePendingCommands(db, frame.id, "set_scenes");
  const command = await enqueueFrameCommand(db, {
    createdByAccountId: accountId,
    frameId: frame.id,
    payload: {
      checksum: payload.checksum,
      scenes: payload.scenes,
      ...(pushSceneId ? { scene_id: pushSceneId } : {}),
      ...(showSceneId && activeState ? { state: activeState } : {}),
    },
    type: "set_scenes",
  });
  // An ESP32 before the firmware that opens a pushed scene with its field
  // values reads set_scenes' scene_id and drops its state: the values follow
  // as the switch they always were, right behind the push.
  if (
    showSceneId &&
    activeState &&
    profile === "esp32" &&
    !(frame.frameosVersion && frameosVersionSatisfies(esp32PushedStateMinVersion, frame.frameosVersion))
  ) {
    await enqueueFrameCommand(db, {
      createdByAccountId: accountId,
      frameId: frame.id,
      payload: { scene_id: showSceneId, state: activeState },
      ttlMs: switchCommandTtlMs,
      type: "set_current_scene",
    });
  }

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
      sceneVersions: Object.fromEntries(
        Object.entries(payload.sceneStates).map(([sceneId, state]) => [
          sceneId,
          state.version,
        ]),
      ),
    },
  };
}

export type UpdatedSceneResult = {
  sceneId: string;
  // False when the frame was already sent the newest version of this scene.
  updated: boolean;
  previousVersion: number | undefined;
  sceneVersion: number;
};

export type UpdateScenesOutcome =
  | {
      ok: true;
      result: {
        // False when the frame was already sent the newest version of every
        // scene asked for: nothing was pushed (a battery frame is not woken
        // for a no-op).
        updated: boolean;
        assignedChecksum: string | null;
        commandId: string | undefined;
        // One entry per scene asked for, in the order asked.
        scenes: UpdatedSceneResult[];
      };
    }
  | { ok: false; failure: AssignScenesFailure };

/**
 * "Update to latest" for the assigned store scenes the caller NAMES — one
 * (the "Update" flag on a scene) or several ("Update all scenes") — in ONE
 * push: move them to their newest published versions. A pinned assignment is
 * re-pinned at that version (it stays pinned — whoever pinned it asked for no
 * surprises); an unpinned one is resolved to the newest version by the push.
 * Every other assignment stays at the version the frame holds — the push
 * carries the whole set, and it used to update every scene with a pending
 * update along with the one that was asked for. Order and grants stay as
 * they are too. A version that newly declares a service-settings group is NOT
 * granted it here: the grant only ever narrows on an update, the owner widens
 * it in the frame's settings.
 */
export async function updateAssignedScenesToLatest(
  db: Database,
  {
    accountId,
    activeSceneId,
    actor,
    frame,
    sceneIds,
  }: {
    accountId: string;
    activeSceneId?: string | undefined;
    actor: unknown;
    frame: FrameRow;
    sceneIds: readonly string[];
  },
): Promise<UpdateScenesOutcome> {
  const existing = await currentSceneAssignments(db, frame.id);
  // Store scene id → the version it moves to; only the scenes that move.
  const moves = new Map<string, number>();
  const scenes: UpdatedSceneResult[] = [];
  for (const sceneId of new Set(sceneIds)) {
    const current = existing.find((entry) => entry.sceneId === sceneId);
    if (!current) {
      return {
        ok: false,
        failure: {
          code: "scene_not_assigned",
          detail: { scene_id: sceneId },
          status: 404,
        },
      };
    }
    const latest = await pinnedSceneVersion(db, sceneId, null);
    if (!latest) {
      return {
        ok: false,
        failure: {
          code: "scene_version_missing",
          detail: { scene_id: sceneId },
          status: 400,
        },
      };
    }
    const previousVersion =
      assignedSceneVersion(frame, sceneId) ?? current.sceneVersion ?? undefined;
    const pinMoves =
      current.sceneVersion !== null && current.sceneVersion !== latest.version;
    const updated = previousVersion !== latest.version || pinMoves;
    if (updated) {
      moves.set(sceneId, latest.version);
    }
    scenes.push({
      previousVersion,
      sceneId,
      sceneVersion: latest.version,
      updated,
    });
  }
  if (moves.size === 0) {
    return {
      ok: true,
      result: {
        assignedChecksum: frame.assignedChecksum,
        commandId: undefined,
        scenes,
        updated: false,
      },
    };
  }
  const outcome = await assignScenesToFrame(db, {
    accountId,
    ...(activeSceneId ? { activeSceneId } : {}),
    actor,
    frame,
    requested: existing.map((entry) => {
      const version = moves.get(entry.sceneId);
      return version === undefined
        ? entry
        : entry.sceneVersion !== null
          ? { ...entry, sceneVersion: version }
          : { ...entry, latest: true };
    }),
    via: "scene_update",
  });
  if (!outcome.ok) {
    return outcome;
  }
  return {
    ok: true,
    result: {
      assignedChecksum: outcome.result.assignedChecksum,
      commandId: outcome.result.commandId,
      scenes: scenes.map((scene) => ({
        ...scene,
        sceneVersion:
          outcome.result.sceneVersions[scene.sceneId] ?? scene.sceneVersion,
      })),
      updated: true,
    },
  };
}

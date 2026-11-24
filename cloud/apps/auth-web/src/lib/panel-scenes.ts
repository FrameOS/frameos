import { createHash } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { createDb, frameSceneAssignments, frames, storeScenes, storeSceneVersions } from "@frameos-cloud/db";
import { recordAuditEvent } from "./audit";
import { readBlob } from "./blobs";
import { reportedActiveSceneId } from "./frame-events";
import {
  assignScenesToFrame,
  currentSceneAssignments,
  maxScenesPerFrame,
  redeployAssignedScenesToFrame,
  updateAssignedScenesToLatest,
} from "./frame-scenes";
import {
  assignedSceneVersion,
  buildScenesPayloadForFrame,
  declaredServiceSettingGroups,
  discardScenePreview,
  enqueueFrameCommand,
  extractScenesJson,
  pinnedSceneVersion,
  publicStoreSceneForFrame,
  readFrameSettings,
  supersedePendingCommands,
} from "./frames";
import {
  declaredSceneGrants,
  grantsWidenedBy,
  redPermissionsAsked,
  type DeclaredSceneGrants,
} from "./panel-code-grants";
import { versionIsLayout, type SceneLayouts } from "./scene-layouts";
import { frameosVersionSatisfies } from "./store-versions";
import type { RequestedScene } from "./frame-scenes";

// A store layout's install shown on the frame is the layout put around every
// scene (docs/scene-store.md "Trying a layout"): each installed scene's
// layout becomes it, by runtime scene id, the way the frame's settings choose
// one for every scene. The scenes the frame holds now say which runtime ids
// each install has (their `origin.storeSceneId`); a layout among them is
// left alone.
function wearingLayout(
  existing: readonly RequestedScene[],
  held: readonly unknown[],
  layoutId: string,
): RequestedScene[] {
  return existing.map((entry) => {
    const ids = held
      .filter((scene): scene is Record<string, unknown> => !!scene && typeof scene === "object")
      .filter((scene) => (scene.origin as { storeSceneId?: unknown } | undefined)?.storeSceneId === entry.sceneId)
      .filter((scene) => !versionIsLayout([scene]))
      .map((scene) => scene.id)
      .filter((id): id is string => typeof id === "string");
    if (ids.length === 0) {
      return entry;
    }
    const layouts: SceneLayouts = { ...(entry.layouts ?? {}) };
    for (const id of ids) {
      layouts[id] = { sceneId: layoutId };
    }
    return { ...entry, layouts };
  });
}

// What a frame may ask of the cloud about its scenes (docs/scene-store.md):
// the Scene store scene on the frame installs, previews, updates and removes
// public store scenes through its host (frameos.storeAction). The frame never
// installs on its own: the cloud holds the list, so a scene the device added
// by itself would go at the next push. Each
// action is what the workspace's button does, run with the frame's own
// credential, and the push that follows is how the frame sees it.
//
// What a frame may do is narrower than what its owner may:
// - public store scenes only (never one of the owner's private ones, which
//   a frame's token could name but its screen never lists);
// - no service key is ever granted: a scene installed from the panel is a new
//   assignment with nothing granted, and the answer's `needs_settings_groups`
//   says what it asks for (the owner grants it where grants are made). What a
//   device asks must never widen a grant (docs/cloud-frames.md). An update
//   that asks for more than the version the frame holds (a permission, a
//   settings key: panel-code-grants.ts) is the owner's (`needs_owner`), as
//   is an install whose scenes replace scenes the frame holds under the same
//   ids and ask for more than they did.
// - nothing new that asks for a red permission (writing the frame's files,
//   reading all of them, the frame's settings, its scenes' code, the store
//   itself: `redScenePermissions`): an install or a preview of such a scene
//   is the owner's too (`needs_owner`). The store on the frame shows no
//   tags, and `storeAction` can be called with nobody at the frame; the
//   workspace is where a red tag is seen and accepted.
// - nothing when the owner turned the settings on the frame's screen off
//   (`frame_settings_on_screen`): the store page is one of them.
//
// `updates` is what the store lists at its top: every public store scene the
// frame holds that has a newer version it can run, `owner: true` on one only
// its owner may update. `updateAll` moves every other one in ONE push.

type Database = ReturnType<typeof createDb>;
type FrameRow = typeof frames.$inferSelect;

export const panelSceneActions = ["install", "update", "updateAll", "updates", "remove", "preview", "discard"] as const;
export type PanelSceneAction = (typeof panelSceneActions)[number];

export type PanelSceneOutcome = {
  body: Record<string, unknown>;
  status: number;
};

/** One store scene on the frame with a newer version (backend panel_scenes.py `scene_updates`). */
export type PanelSceneUpdate = { from: number; name: string; owner?: true; store: string; to: number };

// One version's scenes.json as stored, yanked or not (the frame may hold a
// yanked one); null when it cannot be read.
async function versionScenes(db: Database, sceneId: string, version: number): Promise<unknown[] | null> {
  const [row] = await db
    .select({ content: storeSceneVersions.content, objectKey: storeSceneVersions.objectKey })
    .from(storeSceneVersions)
    .where(and(eq(storeSceneVersions.sceneId, sceneId), eq(storeSceneVersions.version, version)))
    .limit(1);
  const content = await readBlob(row);
  return (content && extractScenesJson(content)?.scenes) ?? null;
}

// What a version's scenes ask for together; null when it cannot be read,
// which grantsWidenedBy takes as asking for nothing yet.
function scenesGrants(scenes: unknown[] | null): DeclaredSceneGrants | null {
  if (!scenes) {
    return null;
  }
  const permissions = new Set<string>();
  const settings = new Set<string>();
  for (const scene of scenes) {
    const grants = declaredSceneGrants(scene);
    grants.permissions.forEach((permission) => permissions.add(permission));
    grants.settings.forEach((key) => settings.add(key));
  }
  return { permissions: [...permissions].sort(), settings: [...settings].sort() };
}

// What moving store scene `sceneId` from `held` (null: not recorded) to
// `latest` asks for beyond what the frame's version asked: empty when the
// frame may do it itself.
async function updateWidens(db: Database, sceneId: string, held: number | null, latest: number): Promise<string[]> {
  const [before, after] = await Promise.all([
    held === null ? Promise.resolve(null) : versionScenes(db, sceneId, held),
    versionScenes(db, sceneId, latest),
  ]);
  return grantsWidenedBy(scenesGrants(before), scenesGrants(after) ?? { permissions: [], settings: [] });
}

// Every public store scene the frame holds with a newer version it can run,
// in the frame's order (the workspace's update_available, GET …/scenes, for
// public scenes alone), and what each update would ask for beyond it.
async function panelSceneUpdates(
  db: Database,
  frame: FrameRow,
): Promise<(PanelSceneUpdate & { widens: string[] })[]> {
  const rows = await db
    .select({
      name: storeScenes.name,
      sceneId: frameSceneAssignments.sceneId,
      sceneVersion: frameSceneAssignments.sceneVersion,
      status: storeScenes.status,
      visibility: storeScenes.visibility,
    })
    .from(frameSceneAssignments)
    .innerJoin(storeScenes, eq(storeScenes.id, frameSceneAssignments.sceneId))
    .where(eq(frameSceneAssignments.frameId, frame.id))
    .orderBy(asc(frameSceneAssignments.position));
  const found: (PanelSceneUpdate & { widens: string[] })[] = [];
  for (const row of rows) {
    if (row.status !== "active" || row.visibility !== "public") {
      continue;
    }
    // A frame from before the per-scene ledger records nothing it holds: no
    // update is claimed (as GET …/scenes).
    const held = assignedSceneVersion(frame, row.sceneId) ?? row.sceneVersion;
    const latest = await pinnedSceneVersion(db, row.sceneId, null);
    if (
      held === null ||
      !latest ||
      latest.version <= held ||
      latest.riskFlags?.includes("shell") ||
      !frameosVersionSatisfies(latest.frameosVersion, frame.frameosVersion)
    ) {
      continue;
    }
    found.push({
      from: held,
      name: row.name,
      store: row.sceneId,
      to: latest.version,
      widens: await updateWidens(db, row.sceneId, held, latest.version),
    });
  }
  return found;
}

async function isPublicStoreScene(db: Database, sceneId: string): Promise<boolean> {
  const [row] = await db
    .select({ status: storeScenes.status, visibility: storeScenes.visibility })
    .from(storeScenes)
    .where(eq(storeScenes.id, sceneId))
    .limit(1);
  return row?.status === "active" && row.visibility === "public";
}

const storeSceneIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const maxRuntimeIdChars = 128;

function refused(error: string, status: number, detail: Record<string, unknown> = {}): PanelSceneOutcome {
  return { body: { error, ok: false, ...detail }, status };
}

export function panelSceneChangesAllowed(frame: { settings: unknown }): boolean {
  return readFrameSettings(frame.settings).frame_settings_on_screen !== false;
}

export async function runPanelSceneAction(
  db: Database,
  frame: FrameRow,
  body: Record<string, unknown>,
): Promise<PanelSceneOutcome> {
  if (frame.status !== "active") {
    return refused("frame_not_active", 409);
  }
  if (!panelSceneChangesAllowed(frame)) {
    return refused("panel_locked", 403);
  }
  const action = body.action;
  if (typeof action !== "string" || !(panelSceneActions as readonly string[]).includes(action)) {
    return refused("invalid_action", 400);
  }
  const sceneId = typeof body.scene_id === "string" ? body.scene_id.toLowerCase() : "";
  // An install shows the scene unless the store asks to stay where it is.
  const show = body.show !== false;
  const accountId = frame.accountId;
  const actor = { accountId, frameId: frame.id, kind: "panel" };
  const active = reportedActiveSceneId(frame.lastState);
  const existing = await currentSceneAssignments(db, frame.id);

  if (action === "discard") {
    // Back to the list the frame holds, showing `scene_id` (a runtime id:
    // the scene the preview was opened from).
    const backTo = typeof body.scene_id === "string" && body.scene_id.length <= maxRuntimeIdChars ? body.scene_id : undefined;
    await discardScenePreview(db, frame.id);
    const outcome = await redeployAssignedScenesToFrame(db, { accountId, activeSceneId: backTo, frame });
    if (!outcome.ok) {
      return refused(outcome.error, 409);
    }
    return { body: { command_id: outcome.commandId, ok: true, status: "queued" }, status: 200 };
  }

  if (action === "updates" || action === "updateAll") {
    const found = await panelSceneUpdates(db, frame);
    if (action === "updates") {
      return {
        body: {
          ok: true,
          updates: found.map(({ widens, ...row }) => ({ ...row, ...(widens.length > 0 ? { owner: true } : {}) })),
        },
        status: 200,
      };
    }
    // Every update the frame may take, in one push; one that asks for more
    // stays the owner's.
    const movable = found.filter((row) => row.widens.length === 0);
    const kept = found.length - movable.length;
    if (movable.length === 0) {
      return { body: { kept, ok: true, status: "up_to_date", updated: 0 }, status: 200 };
    }
    const outcome = await updateAssignedScenesToLatest(db, {
      accountId,
      activeSceneId: active,
      actor,
      frame,
      sceneIds: movable.map((row) => row.store),
    });
    if (!outcome.ok) {
      return refused(outcome.failure.code, outcome.failure.status, outcome.failure.detail);
    }
    return {
      body: {
        command_id: outcome.result.commandId,
        kept,
        ok: true,
        status: outcome.result.updated ? "queued" : "up_to_date",
        updated: outcome.result.scenes.filter((scene) => scene.updated).length,
      },
      status: 200,
    };
  }

  if (!storeSceneIdPattern.test(sceneId)) {
    return refused("invalid_scene", 400);
  }
  const assigned = existing.find((entry) => entry.sceneId.toLowerCase() === sceneId);

  if (action === "install") {
    if (assigned) {
      // Already on the frame: show it, which is what the person asked for
      // (nothing to do when they asked to stay).
      if (!show) {
        return { body: { already_assigned: true, ok: true, status: "up_to_date" }, status: 200 };
      }
      const outcome = await assignScenesToFrame(db, {
        accountId,
        activateStoreSceneId: assigned.sceneId,
        actor,
        frame,
        requested: existing,
        via: "panel",
      });
      return outcome.ok
        ? { body: { already_assigned: true, command_id: outcome.result.commandId, ok: true, status: "queued" }, status: 200 }
        : refused(outcome.failure.code, outcome.failure.status, outcome.failure.detail);
    }
    if (existing.length >= maxScenesPerFrame) {
      return refused("too_many_scenes", 409, { max: maxScenesPerFrame });
    }
    const scene = await publicStoreSceneForFrame(db, frame, sceneId);
    if ("error" in scene) {
      return refused(scene.error, scene.error === "invalid_scene" ? 404 : 409);
    }
    // The scenes the frame holds now. One under an id of the new version's
    // (an older copy from elsewhere: the owner's own, an imported one,
    // another store scene's) is what the new one takes the place of on the
    // frame, so, as for an update, the scenes that take its place may ask for
    // nothing more than the copies they replace (backend panel_scenes.py). A
    // set that cannot be built is refused by the push below.
    // A scene that takes no held scene's place is new to the frame: it may
    // ask for no red permission.
    const built = await buildScenesPayloadForFrame(db, frame.id);
    const newIds = new Set(scene.scenes.map((entry) => entry.id));
    const replaced =
      "error" in built ? [] : built.scenes.filter((entry) => newIds.has((entry as { id?: unknown } | null)?.id));
    const heldIds = new Set<unknown>(replaced.map((entry) => (entry as { id?: unknown }).id));
    const needs = [
      ...(replaced.length > 0
        ? grantsWidenedBy(
            scenesGrants(replaced),
            scenesGrants(scene.scenes.filter((entry) => heldIds.has(entry.id))) ?? { permissions: [], settings: [] },
          )
        : []),
      ...redPermissionsAsked(scenesGrants(scene.scenes.filter((entry) => !heldIds.has(entry.id)))),
    ];
    if (needs.length > 0) {
      return refused("needs_owner", 403, { needs: [...new Set(needs)] });
    }
    // A layout is never shown on its own: shown, it goes around every scene,
    // and the frame stays on the scene it shows.
    const layout = versionIsLayout(scene.scenes.slice(0, 1)) ? (scene.scenes[0]?.id as string | undefined) : undefined;
    const requested: RequestedScene[] =
      layout && show && !("error" in built) ? wearingLayout(existing, built.scenes, layout) : existing;
    const outcome = await assignScenesToFrame(db, {
      accountId,
      // Shown now, or the frame stays on the scene it shows (the store).
      ...(show && !layout ? { activateStoreSceneId: sceneId } : { activeSceneId: active }),
      actor,
      frame,
      // Nothing granted (settingsGroups: []): see the top of this file.
      requested: [...requested, { latest: true, sceneId, sceneVersion: null, settingsGroups: [] }],
      via: "panel",
    });
    if (!outcome.ok) {
      return refused(outcome.failure.code, outcome.failure.status, outcome.failure.detail);
    }
    return {
      body: {
        command_id: outcome.result.commandId,
        needs_settings_groups: declaredServiceSettingGroups(scene.scenes),
        ok: true,
        status: "queued",
        version: outcome.result.sceneVersions[sceneId] ?? scene.version,
      },
      status: 200,
    };
  }

  if (action === "update" || action === "remove") {
    if (!assigned) {
      return refused("scene_not_assigned", 404);
    }
    if (action === "update") {
      // Public store scenes only, and nothing that asks for more than the
      // version the frame holds.
      if (!(await isPublicStoreScene(db, assigned.sceneId))) {
        return refused("invalid_scene", 404);
      }
      const held = assignedSceneVersion(frame, assigned.sceneId) ?? assigned.sceneVersion;
      const latest = await pinnedSceneVersion(db, assigned.sceneId, null);
      if (latest && latest.version !== held) {
        const needs = await updateWidens(db, assigned.sceneId, held, latest.version);
        if (needs.length > 0) {
          return refused("needs_owner", 403, { needs });
        }
      }
      const outcome = await updateAssignedScenesToLatest(db, {
        accountId,
        activeSceneId: active,
        actor,
        frame,
        sceneIds: [assigned.sceneId],
      });
      if (!outcome.ok) {
        return refused(outcome.failure.code, outcome.failure.status, outcome.failure.detail);
      }
      return {
        body: {
          command_id: outcome.result.commandId,
          ok: true,
          status: outcome.result.updated ? "queued" : "up_to_date",
          version: outcome.result.scenes[0]?.sceneVersion,
        },
        status: 200,
      };
    }
    // A frame keeps one scene at least, as the ESP32's own store does.
    const remaining = existing.filter((entry) => entry !== assigned);
    if (remaining.length === 0) {
      return refused("last_scene", 409);
    }
    const outcome = await assignScenesToFrame(db, {
      accountId,
      // The device ignores an id the push does not hold and shows its first
      // scene: what it does when the scene showing is the one removed.
      activeSceneId: active,
      actor,
      frame,
      requested: remaining,
      via: "panel",
    });
    if (!outcome.ok) {
      return refused(outcome.failure.code, outcome.failure.status, outcome.failure.detail);
    }
    return { body: { command_id: outcome.result.commandId, ok: true, status: "queued" }, status: 200 };
  }

  // preview: the frame's list as it is, with the store scene beside it, shown
  // now (docs/scene-previews.md: one preview a frame, ended by Install or
  // Discard). The list stays on the frame, so the scene switcher still has
  // every scene and the way back.
  if (assigned) {
    return refused("already_assigned", 409);
  }
  const scene = await publicStoreSceneForFrame(db, frame, sceneId);
  if ("error" in scene) {
    return refused(scene.error, scene.error === "invalid_scene" ? 404 : 409);
  }
  const built = await buildScenesPayloadForFrame(db, frame.id);
  if ("error" in built) {
    return refused(built.error, 409);
  }
  const held = new Set<unknown>(built.scenes.map((entry) => (entry as { id?: unknown } | null)?.id));
  const previewed = scene.scenes.filter((entry) => !held.has(entry.id));
  // A preview runs the scene on the frame with what its apps ask for: one
  // that asks for a red permission is the owner's to put there.
  const previewNeeds = redPermissionsAsked(scenesGrants(previewed));
  if (previewNeeds.length > 0) {
    return refused("needs_owner", 403, { needs: previewNeeds });
  }
  const shown = previewed[0] ?? scene.scenes[0];
  const shownId = shown?.id as string;
  const scenes = [...built.scenes, ...previewed];
  const checksum = createHash("sha256").update(JSON.stringify(scenes)).digest("hex");
  await supersedePendingCommands(db, frame.id, "set_scenes");
  const command = await enqueueFrameCommand(db, {
    createdByAccountId: accountId,
    frameId: frame.id,
    payload: {
      checksum,
      preview: { name: scene.name, scene: shown, scene_id: shownId, source: "panel" },
      // Shown now, unless the store asks to stay: a layout tried is worn by
      // the scene showing, never shown on its own.
      ...(show ? { scene_id: shownId } : {}),
      scenes,
    },
    type: "set_scenes",
  });
  await recordAuditEvent(db, {
    accountId,
    actor,
    eventType: "frame.command_sent",
    metadata: { checksum, scene_count: scenes.length, source: "panel", store_scene_id: sceneId, type: "set_scenes" },
    target: { commandId: command?.id, frameId: frame.id },
  });
  return {
    body: {
      command_id: command?.id,
      needs_settings_groups: declaredServiceSettingGroups(scene.scenes),
      ok: true,
      scene_id: shownId,
      status: "queued",
    },
    status: 200,
  };
}

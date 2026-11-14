import { createHash } from "node:crypto";
import { createDb, frames } from "@frameos-cloud/db";
import { recordAuditEvent } from "./audit";
import { reportedActiveSceneId } from "./frame-events";
import {
  assignScenesToFrame,
  currentSceneAssignments,
  maxScenesPerFrame,
  redeployAssignedScenesToFrame,
  updateAssignedScenesToLatest,
} from "./frame-scenes";
import {
  buildScenesPayloadForFrame,
  declaredServiceSettingGroups,
  discardScenePreview,
  enqueueFrameCommand,
  publicStoreSceneForFrame,
  readFrameSettings,
  supersedePendingCommands,
} from "./frames";

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
//   device asks must never widen a grant (docs/cloud-frames.md).
// - nothing when the owner turned the settings on the frame's screen off
//   (`frame_settings_on_screen`): the store page is one of them.

type Database = ReturnType<typeof createDb>;
type FrameRow = typeof frames.$inferSelect;

export const panelSceneActions = ["install", "update", "remove", "preview", "discard"] as const;
export type PanelSceneAction = (typeof panelSceneActions)[number];

export type PanelSceneOutcome = {
  body: Record<string, unknown>;
  status: number;
};

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
    const outcome = await assignScenesToFrame(db, {
      accountId,
      // Shown now, or the frame stays on the scene it shows (the store).
      ...(show ? { activateStoreSceneId: sceneId } : { activeSceneId: active }),
      actor,
      frame,
      // Nothing granted (settingsGroups: []): see the top of this file.
      requested: [...existing, { latest: true, sceneId, sceneVersion: null, settingsGroups: [] }],
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
      scene_id: shownId,
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

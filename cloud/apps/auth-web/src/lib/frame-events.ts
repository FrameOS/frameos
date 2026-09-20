// Pure halves of the frame event route
// (app/api/frames/[frameId]/event/[eventName]/route.ts), kept out of the
// route so they can be tested without a database.

import type { ContractProfile } from "./cloud-frames-contract";

const maxSceneIdChars = 256;

export type SceneStateCommand =
  | { ok: true; payload: { scene_id: string; state: Record<string, unknown> } }
  | { ok: false; error: string; status: number };

/** The scene a frame last reported as the one it shows (`last_state` is the
 * device's `states` map plus `active_scene`, in the device's own spelling). */
export function reportedActiveSceneId(lastState: unknown): string | undefined {
  if (!lastState || typeof lastState !== "object" || Array.isArray(lastState)) {
    return undefined;
  }
  const activeScene = (lastState as Record<string, unknown>).active_scene;
  return typeof activeScene === "string" &&
    activeScene.length > 0 &&
    activeScene.length <= maxSceneIdChars
    ? activeScene
    : undefined;
}

/**
 * `setSceneState` — "set public state on the scene the frame is showing, and
 * render" — has no verb of its own (the generic scene-event verb is planned,
 * docs/event-system-analysis.md §4.2). What the contract does have is
 * `set_current_scene {scene_id, state}`, and the full runtime treats one that
 * names the scene ALREADY showing as exactly this: apply `state`, render, no
 * switch (runner.nim, the `elif payload.hasKey("state")` branch). So the event
 * becomes that verb, aimed at the scene the frame last reported.
 *
 * Two limits, both honest refusals rather than a silent no-op:
 * - esp32: the firmware's `set_current_scene` reads `scene_id` only and drops
 *   `state` (fos_cloud.c), so the command would re-render and change nothing.
 * - a frame that has not reported an active scene yet: there is nothing to aim
 *   at, and guessing would switch scenes.
 *
 * What it is not: the scene receives `setCurrentScene`, not `setSceneState`,
 * so an event node listening for `setSceneState` does not run; and if the
 * frame switches scenes between its last report and this command, the command
 * switches it back. Both go away with the generic verb.
 */
export function sceneStateCommand(input: {
  lastState: unknown;
  profile: ContractProfile;
  state: Record<string, unknown> | undefined;
}): SceneStateCommand {
  if (input.profile !== "linux") {
    return { error: "unsupported_event", ok: false, status: 404 };
  }
  if (!input.state) {
    return { error: "invalid_state", ok: false, status: 400 };
  }
  const sceneId = reportedActiveSceneId(input.lastState);
  if (!sceneId) {
    return { error: "active_scene_unknown", ok: false, status: 409 };
  }
  return { ok: true, payload: { scene_id: sceneId, state: input.state } };
}

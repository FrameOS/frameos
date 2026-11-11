// `scenes_patch`: a set_scenes sent to an ESP32 as only what changed since the
// set it holds (docs/cloud-frames.md, `embedded/esp32/README.md` "Scene
// storage"). The firmware stores one file per scene, so a push that changes
// one scene writes one file and leaves the scene on the panel alone.
//
// The queue row is still a set_scenes, carrying the whole list: the hub works
// the difference out when it sends it, and a frame that refuses the patch
// (`base_mismatch`, or firmware that predates the verb answering
// `unknown_verb`) gets the whole list from that row instead.
import { createHash } from "node:crypto";

// The first release with the verb: 2026.11.5 shipped without it and answers
// `unknown_verb`, which cost every push to it twice (the patch, then the list).
export const scenesPatchMinVersion = "2026.11.6";

// The first ESP32 firmware that opens a pushed scene (set_scenes' or
// scenes_patch's `scene_id`) with the push's `state`; before it the values
// travel as a set_current_scene behind the push (frame-scenes.ts).
export const esp32PushedStateMinVersion = "2026.11.6";

function sceneId(scene: unknown): string | null {
  if (!scene || typeof scene !== "object" || Array.isArray(scene)) {
    return null;
  }
  const id = (scene as Record<string, unknown>).id;
  return typeof id === "string" && id ? id : null;
}

/**
 * Whether a scenes_patch leaves the panel as it was: it names no scene to show,
 * the scene showing stays in the set and is not among the scenes put. The
 * firmware renders a patch only when it touches the scene showing, so for this
 * one nothing renders and its scene_ack ends the deploy's bar
 * (docs/deploy-progress-contract.json `scene_ack:unshown`). An install without
 * activate is one. Not knowing the scene showing, a render is expected.
 */
export function patchLeavesPanel(patch: Record<string, unknown>, activeSceneId: unknown): boolean {
  if (typeof patch.scene_id === "string" && patch.scene_id) {
    return false;
  }
  if (typeof activeSceneId !== "string" || !activeSceneId) {
    return false;
  }
  const order = Array.isArray(patch.order) ? patch.order : [];
  const put = Array.isArray(patch.put) ? patch.put : [];
  return order.includes(activeSceneId) && !put.some((scene) => sceneId(scene) === activeSceneId);
}

/** Each scene's digest by id, or null when the list is not one patches can describe. */
export function sceneHashes(scenes: readonly unknown[]): Record<string, string> | null {
  const hashes: Record<string, string> = {};
  for (const scene of scenes) {
    const id = sceneId(scene);
    if (id === null || id in hashes) {
      return null;
    }
    hashes[id] = createHash("sha256").update(JSON.stringify(scene)).digest("hex");
  }
  return hashes;
}

/**
 * The verb to send in place of a set_scenes row, or null to send the whole list.
 * `base` is the set the frame holds: its checksum and each scene's digest.
 */
export function buildScenesPatchMessage(
  command: { id: string; payload: unknown },
  base: { checksum: string; hashes: Record<string, string> },
): Record<string, unknown> | null {
  const payload = command.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const { scenes, scene_hashes: _hashes, no_patch: _noPatch, ...rest } = payload as Record<string, unknown>;
  if (!Array.isArray(scenes) || scenes.length === 0 || typeof rest.checksum !== "string" || !rest.checksum) {
    return null;
  }
  const hashes = sceneHashes(scenes);
  if (hashes === null) {
    return null;
  }
  const put = scenes.filter((scene) => hashes[sceneId(scene) as string] !== base.hashes[sceneId(scene) as string]);
  // Every scene changed: the whole list is the same message.
  if (put.length === scenes.length) {
    return null;
  }
  return {
    ...rest,
    base_checksum: base.checksum,
    id: command.id,
    order: scenes.map((scene) => sceneId(scene)),
    put,
    type: "scenes_patch",
  };
}

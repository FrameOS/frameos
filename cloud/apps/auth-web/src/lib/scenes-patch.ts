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

// The ESP32 scene store's slot files (FOS_SCENE_STORE_SLOTS in
// embedded/esp32/main/fos_scene_store.h; the backend's
// ESP32_SCENE_STORE_SLOTS). scenes-patch.test.ts and the backend's
// test_embedded_scenes_patch_slots.py read the header. 256 from 2026.11.12,
// twice the 128 scenes a set holds there, so a change to every scene fits
// beside the set; 32 on the firmware before it, and on one whose version is
// not known.
export const esp32SceneStoreSlots = 256;
export const esp32SceneStoreSlotsBefore = 32;
export const esp32SceneStoreSlotsVersion = "2026.11.12";

// The most scenes a set holds on that store (FOS_SCENE_STORE_SCENES in the
// same header): a set with more cannot be sent at all.
export const esp32SceneStoreScenes = 128;

// The most one management WebSocket message to an ESP32 may be
// (FOS_CLOUD_WS_MAX_MSG in embedded/esp32/main/fos_cloud.c): the board holds
// a message in memory whole and acks a bigger one `message_too_large`. It
// bounds one message, not the set: from esp32SceneStoreSlotsVersion a set is
// as big as /state has room for, and one over this goes in parts
// (nextScenesPart). scenes-patch.test.ts reads the firmware for both numbers.
export const esp32MaxMessageBytes = 512 * 1024;

// What one part of a set sent in parts aims to stay under: half the cap. The
// board holds the message and its cJSON tree together, beside whatever the
// panel's render has, and a part costs one index write however small it is,
// so this is the fewest bytes held at once that still sends a 3 MiB set in a
// dozen messages. A scene bigger than this goes alone, up to the cap.
export const esp32ScenesPartBytes = 256 * 1024;

function versionParts(version: string | null | undefined): number[] | null {
  const numbers = typeof version === "string" ? /^v?(\d+(?:\.\d+)*)/.exec(version.trim())?.[1] : undefined;
  return numbers ? numbers.split(".").map(Number) : null;
}

/** The slot files of the scene store on a board running `frameosVersion`. */
export function esp32SceneStoreSlotsFor(frameosVersion: string | null | undefined): number {
  const runs = versionParts(frameosVersion);
  const first = versionParts(esp32SceneStoreSlotsVersion) as number[];
  if (runs === null) {
    return esp32SceneStoreSlotsBefore;
  }
  for (let i = 0; i < Math.max(runs.length, first.length); i++) {
    const difference = (runs[i] ?? 0) - (first[i] ?? 0);
    if (difference !== 0) {
      return difference > 0 ? esp32SceneStoreSlots : esp32SceneStoreSlotsBefore;
    }
  }
  return esp32SceneStoreSlots;
}

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
 * Each scene's digest by id for a set_scenes row about to go out: the ones
 * the row has kept since it was queued (`scene_hashes`, enqueueFrameCommand),
 * which are what the next push's base is read from. Worked out from the
 * scenes only when the row has none for exactly these scenes: the queue's
 * jsonb column gives an object's keys back in its own order (by length, then
 * bytes), so the digest of a scene read from it is not the digest it was
 * queued with, and every scene whose keys were in another order looked
 * changed: such a push went out whole, never as a patch.
 */
function rowSceneHashes(payload: Record<string, unknown>, scenes: readonly unknown[]): Record<string, string> | null {
  const kept = payload.scene_hashes;
  if (kept && typeof kept === "object" && !Array.isArray(kept) && Object.keys(kept).length === scenes.length) {
    const hashes = kept as Record<string, unknown>;
    const ids = new Set(scenes.map((scene) => sceneId(scene)));
    if (
      ids.size === scenes.length &&
      [...ids].every(
        (id) => id !== null && Object.prototype.hasOwnProperty.call(hashes, id) && typeof hashes[id] === "string",
      )
    ) {
      return hashes as Record<string, string>;
    }
  }
  return sceneHashes(scenes);
}

/**
 * The verb to send in place of a set_scenes row, or null to send the whole list.
 * `base` is the set the frame holds: its checksum and each scene's digest, and
 * the slot files its store has (esp32SceneStoreSlotsFor its firmware; the
 * fewest when it is not said).
 */
export function buildScenesPatchMessage(
  command: { id: string; payload: unknown },
  base: { checksum: string; hashes: Record<string, string>; slots?: number },
): Record<string, unknown> | null {
  const payload = command.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const {
    scenes,
    scene_hashes: _hashes,
    no_patch: _noPatch,
    part: _part,
    ...rest
  } = payload as Record<string, unknown>;
  if (!Array.isArray(scenes) || scenes.length === 0 || typeof rest.checksum !== "string" || !rest.checksum) {
    return null;
  }
  const hashes = rowSceneHashes(payload as Record<string, unknown>, scenes);
  if (hashes === null) {
    return null;
  }
  const put = scenes.filter((scene) => hashes[sceneId(scene) as string] !== base.hashes[sceneId(scene) as string]);
  // Every scene changed: the whole list is the same message.
  if (put.length === scenes.length) {
    return null;
  }
  // A patch is one change on the board: each put goes to a new slot while
  // every scene it holds keeps its own until the index switches. One that
  // cannot fit would be refused ("no free scene slot") and cost a round trip;
  // the whole list is written a scene at a time and fits.
  if (Object.keys(base.hashes).length + put.length > (base.slots ?? esp32SceneStoreSlotsBefore)) {
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

// ---------------------------------------------------------------------------
// A set in parts: a set_scenes row whose one message would be over the
// board's cap goes out as several, each under it, and ends with the frame
// holding exactly the row's set under the row's checksum. Only verbs the
// firmware has: a `scenes_patch` against the set the frame holds, or, when
// that set is not known, a `set_scenes` of the scenes that fit and patches
// from there. The firmware takes a patch only against the checksum it last
// applied (`base_checksum`, fos_cloud.c), so every part but the last carries
// a checksum of its own for the set it leaves, and the next part names it.

/** A set a frame holds: its checksum and each scene's digest by id. */
export interface HeldScenes {
  checksum: string;
  hashes: Record<string, string>;
}

export interface ScenesPartLimits {
  /** The board's cap on one message. */
  maxBytes: number;
  /** What a part aims to stay under; a scene bigger than it goes alone. */
  partBytes: number;
  /** The most scenes a set holds. */
  maxScenes: number;
}

export type ScenesPart =
  | {
      ok: true;
      /** The last part: the row's own id, checksum, scene_id and state. */
      final: boolean;
      /** What the frame holds once this part is live. */
      holds: HeldScenes;
      message: Record<string, unknown>;
    }
  | { ok: false; error: "payload_too_large" | "too_many_scenes" };

/**
 * What a set_scenes row keeps while it goes out in parts (`payload.part`):
 * the set the part last sent leaves on the frame, the set that part was
 * worked out from (`from`, what the frame still holds if the part never
 * arrived), and how often the frame took the part without it going live.
 */
export interface ScenesPartRecord extends HeldScenes {
  accepted?: number;
  from?: HeldScenes;
}

function heldScenes(value: unknown): HeldScenes | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const { checksum, hashes } = value as Record<string, unknown>;
  if (typeof checksum !== "string" || !checksum || !hashes || typeof hashes !== "object" || Array.isArray(hashes)) {
    return null;
  }
  if (!Object.values(hashes).every((hash) => typeof hash === "string")) {
    return null;
  }
  return { checksum, hashes: hashes as Record<string, string> };
}

export function scenesPartRecord(value: unknown): ScenesPartRecord | null {
  const held = heldScenes(value);
  if (held === null) {
    return null;
  }
  const { accepted, from } = value as Record<string, unknown>;
  const before = heldScenes(from);
  return {
    ...held,
    ...(typeof accepted === "number" && Number.isFinite(accepted) ? { accepted } : {}),
    ...(before ? { from: before } : {}),
  };
}

function holds(hashes: Record<string, string>, id: string): boolean {
  return Object.prototype.hasOwnProperty.call(hashes, id);
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

// The checksum of a set between two parts: its scenes' digests in order. Not
// the row's (the frame would report the push done) and never the base's (the
// firmware takes a patch whose checksum it holds for one it applied already).
function partChecksum(order: readonly string[], hashes: Record<string, string>): string {
  const digest = createHash("sha256").update("scenes part");
  for (const id of order) {
    digest.update(`\n${JSON.stringify(id)}:${hashes[id]}`);
  }
  return digest.digest("hex");
}

/**
 * The next message of a set_scenes row that goes out in parts, from the set
 * the frame holds (`base`; null when it is not known: the part is then a
 * `set_scenes` of the scenes that fit, and the frame holds those alone).
 *
 * A part that is not the last (`final: false`) has `partId` for its id and a
 * checksum of its own; the caller sends the next one once the frame reports
 * that checksum (`holds`, the base of the next call). What every set between
 * two parts keeps to:
 *  - it is the new set's scenes, the ones sent so far as they will be and the
 *    rest as the frame had them, plus the scene on the panel (`showing`) when
 *    the new set drops it: that one goes with the last part, like a change to
 *    the scene on the panel. Any other scene the new set drops goes with the
 *    first part, so its room is free for what comes;
 *  - it never holds more than `maxScenes`;
 *  - `scene_id` and `state` ("Push & activate") travel with the last part.
 * Deterministic: the same row, base and showing scene give the same part, so
 * a part sent twice is the same change.
 */
export function nextScenesPart(
  command: { id: string; payload: unknown },
  base: HeldScenes | null,
  options: { partId: string; showing?: unknown; limits?: Partial<ScenesPartLimits> | undefined },
): ScenesPart {
  const limits: ScenesPartLimits = {
    maxBytes: esp32MaxMessageBytes,
    maxScenes: esp32SceneStoreScenes,
    partBytes: esp32ScenesPartBytes,
    ...options.limits,
  };
  const refused = { error: "payload_too_large", ok: false } as const;
  const payload = command.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return refused;
  }
  const {
    scenes,
    scene_hashes: _hashes,
    no_patch: _noPatch,
    part: _part,
    ...rest
  } = payload as Record<string, unknown>;
  const target = rest.checksum;
  if (!Array.isArray(scenes) || scenes.length === 0 || typeof target !== "string" || !target) {
    return refused;
  }
  // A list patches cannot name cannot be told apart part by part either.
  const hashes = rowSceneHashes(payload as Record<string, unknown>, scenes);
  if (hashes === null) {
    return refused;
  }
  if (scenes.length > limits.maxScenes) {
    return { error: "too_many_scenes", ok: false };
  }
  const idOf = (scene: unknown) => sceneId(scene) as string;
  const order = scenes.map(idOf);
  const inTarget = new Set(order);
  const showing = typeof options.showing === "string" ? options.showing : "";
  const sizes = new Map(scenes.map((scene) => [idOf(scene), jsonBytes(scene)]));

  // The most a message is before its scenes: the last part's (the row's own
  // fields, the whole order) or one between (the scene on the panel named too).
  const longest = base && base.checksum.length > 64 ? base.checksum : "0".repeat(64);
  const envelope = Math.max(
    jsonBytes({ ...rest, base_checksum: longest, id: command.id, order, put: [], type: "scenes_patch" }),
    jsonBytes({
      base_checksum: longest,
      checksum: longest,
      id: options.partId,
      order: [...order, showing],
      put: [],
      type: "scenes_patch",
    }),
  );
  const tooBig = (scene: unknown) => envelope + (sizes.get(idOf(scene)) ?? 0) > limits.maxBytes;
  // As many as fit one part, first fit in the order given; the first is
  // taken whatever its size (tooBig is asked before: it fits a message).
  const fill = (candidates: readonly unknown[], room: (id: string) => boolean = () => true) => {
    const taken: unknown[] = [];
    let bytes = envelope;
    for (const scene of candidates) {
      const id = idOf(scene);
      const size = (sizes.get(id) ?? 0) + (taken.length > 0 ? 1 : 0);
      if ((taken.length > 0 && bytes + size > limits.partBytes) || !room(id)) {
        continue;
      }
      taken.push(scene);
      bytes += size;
    }
    return taken;
  };
  // One message for all that is left: when it fits a part, or is one scene.
  const last = (message: Record<string, unknown>, left: number): ScenesPart | null => {
    const bytes = jsonBytes(message);
    return bytes <= limits.partBytes || (left <= 1 && bytes <= limits.maxBytes)
      ? { final: true, holds: { checksum: target, hashes }, message, ok: true }
      : null;
  };
  const between = (
    partOrder: string[],
    held: Record<string, string>,
    message: Record<string, unknown>,
  ): ScenesPart => {
    const checksum = partChecksum(partOrder, held);
    return {
      final: false,
      holds: { checksum, hashes: held },
      message: { ...message, checksum, id: options.partId },
      ok: true,
    };
  };

  if (base === null) {
    // Nothing is known of what the frame holds: the scenes that fit replace
    // it, the scene on the panel among them so the panel stays on it.
    if (scenes.some(tooBig)) {
      return refused;
    }
    const whole = last({ ...rest, id: command.id, scenes, type: "set_scenes" }, scenes.length);
    if (whole) {
      return whole;
    }
    const taken = new Set(
      fill([
        ...scenes.filter((scene) => idOf(scene) === showing),
        ...scenes.filter((scene) => idOf(scene) !== showing),
      ]).map(idOf),
    );
    const subset = scenes.filter((scene) => taken.has(idOf(scene)));
    const partOrder = subset.map(idOf);
    const held = Object.fromEntries(partOrder.map((id) => [id, hashes[id] as string]));
    return between(partOrder, held, { scenes: subset, type: "set_scenes" });
  }

  const before = (id: string) => (holds(base.hashes, id) ? base.hashes[id] : undefined);
  const todo = scenes.filter((scene) => hashes[idOf(scene)] !== before(idOf(scene)));
  if (todo.some(tooBig)) {
    return refused;
  }
  const final = { ...rest, base_checksum: base.checksum, id: command.id, order, put: todo, type: "scenes_patch" };
  const whole = last(final, todo.length);
  if (whole) {
    return whole;
  }
  // What a part keeps of the set held: the scenes the new set has, and the
  // one on the panel. A new scene joins only while the set has a place.
  const dropsShowing = showing !== "" && holds(base.hashes, showing) && !inTarget.has(showing);
  let count = Object.keys(base.hashes).filter((id) => inTarget.has(id)).length + (dropsShowing ? 1 : 0);
  const room = (id: string) => {
    if (holds(base.hashes, id)) {
      return true;
    }
    if (count >= limits.maxScenes) {
      return false;
    }
    count += 1;
    return true;
  };
  let put = fill(
    todo.filter((scene) => idOf(scene) !== showing),
    room,
  );
  if (put.length === 0) {
    // What is left is the scene on the panel, and a scene the count holds
    // back for the last part: as one message when the board takes it.
    if (jsonBytes(final) <= limits.maxBytes) {
      return { final: true, holds: { checksum: target, hashes }, message: final, ok: true };
    }
    put = fill(
      todo.filter((scene) => idOf(scene) === showing),
      room,
    );
    if (put.length === 0) {
      return refused;
    }
  }
  const putIds = new Set(put.map(idOf));
  const partOrder = order.filter((id) => holds(base.hashes, id) || putIds.has(id));
  if (dropsShowing) {
    partOrder.push(showing);
  }
  const held = Object.fromEntries(
    partOrder.map((id) => [id, (putIds.has(id) ? hashes[id] : base.hashes[id]) as string]),
  );
  return between(partOrder, held, { base_checksum: base.checksum, order: partOrder, put, type: "scenes_patch" });
}

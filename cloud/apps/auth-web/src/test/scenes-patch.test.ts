import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildScenesPatchMessage,
  esp32MaxMessageBytes,
  esp32SceneStoreScenes,
  esp32SceneStoreSlots,
  esp32SceneStoreSlotsBefore,
  esp32SceneStoreSlotsFor,
  esp32SceneStoreSlotsVersion,
  esp32ScenesPartBytes,
  nextScenesPart,
  patchLeavesPanel,
  sceneHashes,
  scenesPartRecord,
  type HeldScenes,
} from "../lib/scenes-patch";

const firmware = (file: string) => readFileSync(join(__dirname, "../../../../../embedded/esp32/main", file), "utf8");

describe("scenes_patch and the board's slots", () => {
  it("counts the firmware's slots, its scenes and its cap on a message", () => {
    const header = firmware("fos_scene_store.h");
    expect(Number(/#define\s+FOS_SCENE_STORE_SLOTS\s+(\d+)/.exec(header)?.[1])).toBe(esp32SceneStoreSlots);
    expect(Number(/#define\s+FOS_SCENE_STORE_SCENES\s+(\d+)/.exec(header)?.[1])).toBe(esp32SceneStoreScenes);
    const cap = /#define\s+FOS_CLOUD_WS_MAX_MSG\s+\((\d+)\s*\*\s*(\d+)\)/.exec(firmware("fos_cloud.c"));
    expect(Number(cap?.[1]) * Number(cap?.[2])).toBe(esp32MaxMessageBytes);
    expect(esp32ScenesPartBytes).toBeLessThan(esp32MaxMessageBytes);
  });

  it("sends the whole list when the puts and the scenes held would not fit", () => {
    const held = Array.from({ length: 25 }, (_, i) => ({ id: `s${i}`, name: `S${i}` }));
    const heldBase = { checksum: "old", hashes: sceneHashes(held) as Record<string, string> };
    // Every scene but one given a layout: 25 held + 24 put > 32.
    const laidOut = held.map((scene, i) => (i === 0 ? scene : { ...scene, layout: "frame" }));
    expect(buildScenesPatchMessage({ id: "c", payload: { checksum: "n", scenes: laidOut } }, heldBase)).toBeNull();
    // 25 held + 7 put = 32 still fits.
    const seven = held.map((scene, i) => (i < 18 ? scene : { ...scene, layout: "frame" }));
    const message = buildScenesPatchMessage({ id: "c", payload: { checksum: "n", scenes: seven } }, heldBase);
    expect(message).toMatchObject({ type: "scenes_patch" });
    expect(message?.put).toHaveLength(7);
    // A board whose store has the slots takes the 24 as a patch.
    const roomy = { ...heldBase, slots: esp32SceneStoreSlotsFor(esp32SceneStoreSlotsVersion) };
    const wide = buildScenesPatchMessage({ id: "c", payload: { checksum: "n", scenes: laidOut } }, roomy);
    expect(wide?.put).toHaveLength(24);
  });

  it("knows the slots by the firmware a board runs", () => {
    expect(esp32SceneStoreSlotsBefore).toBe(32);
    expect(esp32SceneStoreSlotsFor("2026.11.11")).toBe(32);
    expect(esp32SceneStoreSlotsFor("2026.11.6")).toBe(32);
    expect(esp32SceneStoreSlotsFor("2026.11.12")).toBe(esp32SceneStoreSlots);
    expect(esp32SceneStoreSlotsFor("v2026.11.12+abc")).toBe(esp32SceneStoreSlots);
    expect(esp32SceneStoreSlotsFor("2026.12.1")).toBe(esp32SceneStoreSlots);
    expect(esp32SceneStoreSlotsFor("2027.1.0")).toBe(esp32SceneStoreSlots);
    // Not known: the fewest, a patch that fits any board.
    expect(esp32SceneStoreSlotsFor(null)).toBe(32);
    expect(esp32SceneStoreSlotsFor("dev")).toBe(32);
  });
});

const a = { id: "a", name: "A" };
const b = { id: "b", name: "B" };
const base = { checksum: "old", hashes: sceneHashes([a, b]) as Record<string, string> };

describe("scenes_patch", () => {
  it("sends only what changed, with the whole order", () => {
    const changed = { ...b, name: "B2" };
    const message = buildScenesPatchMessage(
      { id: "cmd", payload: { checksum: "new", scene_id: "b", scenes: [a, changed], scene_hashes: { x: "y" } } },
      base,
    );
    expect(message).toEqual({
      base_checksum: "old",
      checksum: "new",
      id: "cmd",
      order: ["a", "b"],
      put: [changed],
      scene_id: "b",
      type: "scenes_patch",
    });
  });

  it("knows a scene by the digest its row kept, not by the order its keys come back in", () => {
    // Queued as {name, id}; the queue's jsonb column gives back {id, name}.
    const queued = [
      { name: "A", id: "a" },
      { name: "B", id: "b" },
    ];
    const kept = sceneHashes(queued) as Record<string, string>;
    const read = [
      { id: "a", name: "A" },
      { id: "b", name: "B2" },
    ];
    const changed = { ...kept, b: (sceneHashes([{ name: "B2", id: "b" }]) as Record<string, string>).b };
    const message = buildScenesPatchMessage(
      { id: "cmd", payload: { checksum: "new", scene_hashes: changed, scenes: read } },
      { checksum: "old", hashes: kept },
    );
    expect(message?.put).toEqual([{ id: "b", name: "B2" }]);
    // Hashes that are not of exactly these scenes are not believed.
    for (const scene_hashes of [{ a: kept.a }, { ...changed, c: "x" }, { a: kept.a, b: 1 }, "x"]) {
      expect(
        buildScenesPatchMessage(
          { id: "cmd", payload: { checksum: "new", scene_hashes, scenes: read } },
          { checksum: "old", hashes: sceneHashes([read[0], { id: "b", name: "B" }]) as Record<string, string> },
        )?.put,
      ).toEqual([{ id: "b", name: "B2" }]);
    }
  });

  it("carries the scene to show and its field values ('Push & activate'), even with nothing to put", () => {
    // The install already landed, then "Push & activate": the same set, a
    // scene to open and its values. The frame switches on it (fos_cloud.c).
    const message = buildScenesPatchMessage(
      { id: "cmd", payload: { checksum: "old", scene_id: "a", state: { city: "Brussels" }, scenes: [a, b] } },
      base,
    );
    expect(message).toMatchObject({ put: [], scene_id: "a", state: { city: "Brussels" }, type: "scenes_patch" });
  });

  it("describes a removal and an order change with nothing to put", () => {
    expect(buildScenesPatchMessage({ id: "c", payload: { checksum: "n", scenes: [b] } }, base)).toMatchObject({
      order: ["b"],
      put: [],
    });
    expect(buildScenesPatchMessage({ id: "c", payload: { checksum: "n", scenes: [b, a] } }, base)).toMatchObject({
      order: ["b", "a"],
      put: [],
    });
  });

  it("sends the whole list when every scene changed", () => {
    expect(
      buildScenesPatchMessage({ id: "c", payload: { checksum: "n", scenes: [{ ...a, name: "x" }] } }, base),
    ).toBeNull();
  });

  it("will not describe a list it cannot name", () => {
    expect(buildScenesPatchMessage({ id: "c", payload: { checksum: "n", scenes: [{ name: "no id" }] } }, base)).toBeNull();
    expect(buildScenesPatchMessage({ id: "c", payload: { checksum: "n", scenes: [a, a] } }, base)).toBeNull();
    expect(buildScenesPatchMessage({ id: "c", payload: { scenes: [a] } }, base)).toBeNull();
    expect(sceneHashes([a, { id: "a" }])).toBeNull();
  });

  it("knows a patch that leaves the panel as it was: nothing renders for it", () => {
    // An install without activate on a frame showing a: b goes on the list.
    const install = { order: ["a", "b"], put: [b], type: "scenes_patch" };
    expect(patchLeavesPanel(install, "a")).toBe(true);
    // A removal of another scene, an order change: the same.
    expect(patchLeavesPanel({ order: ["b", "a"], put: [] }, "a")).toBe(true);
    // The scene showing changed, or it went, or a scene is named to show: a render follows.
    expect(patchLeavesPanel({ order: ["a", "b"], put: [{ ...a, name: "A2" }] }, "a")).toBe(false);
    expect(patchLeavesPanel({ order: ["b"], put: [] }, "a")).toBe(false);
    expect(patchLeavesPanel({ ...install, scene_id: "b" }, "a")).toBe(false);
    // Not knowing what the frame shows: a render is expected, as before.
    expect(patchLeavesPanel(install, undefined)).toBe(false);
    expect(patchLeavesPanel(install, "")).toBe(false);
  });
});

// What the firmware does with a scene message, as far as a provider can
// tell: the cap on one message (fos_cloud.c WEBSOCKET_EVENT_DATA), a patch
// taken only against the checksum last applied and one whose checksum it
// holds acked as applied already (ws_handle_set_scenes), and the store's
// change (fos_scene_store_apply: every put a new slot beside the set held,
// `order` naming a scene held or put, 128 scenes at most, never none).
class Board {
  scenes: Array<{ id: string }> = [];
  applied = "";
  // Every set this board held, for what must be true of each.
  held: string[][] = [];

  take(message: Record<string, unknown>): string | null {
    if (Buffer.byteLength(JSON.stringify(message), "utf8") > esp32MaxMessageBytes) {
      return "message_too_large";
    }
    const checksum = String(message.checksum);
    if (message.type === "set_scenes") {
      const scenes = message.scenes as Array<{ id: string }>;
      if (scenes.length === 0 || scenes.length > esp32SceneStoreScenes) {
        return "scene_store_failed";
      }
      return this.hold(scenes, checksum);
    }
    if (checksum === this.applied) {
      return null;
    }
    if (message.base_checksum !== this.applied) {
      return "base_mismatch";
    }
    const put = message.put as Array<{ id: string }>;
    if (this.scenes.length + put.length > esp32SceneStoreSlots) {
      return "no_room";
    }
    const next: Array<{ id: string }> = [];
    for (const id of message.order as string[]) {
      const scene = put.find((candidate) => candidate.id === id) ?? this.scenes.find((candidate) => candidate.id === id);
      if (!scene) {
        return "patch_refused";
      }
      next.push(scene);
    }
    if (next.length === 0) {
      return "patch_refused";
    }
    if (next.length > esp32SceneStoreScenes) {
      return "no_room";
    }
    return this.hold(next, checksum);
  }

  private hold(scenes: Array<{ id: string }>, checksum: string): null {
    this.scenes = scenes;
    this.applied = checksum;
    this.held.push(scenes.map((scene) => scene.id));
    return null;
  }

  get base(): HeldScenes {
    return { checksum: this.applied, hashes: sceneHashes(this.scenes) as Record<string, string> };
  }
}

const scene = (id: string, kb: number, extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  pad: "x".repeat(kb * 1024),
  ...extra,
});

// Send a row to a board part by part, each against what the part before
// left, as the hub does: the messages, in order.
function deliver(
  board: Board,
  payload: Record<string, unknown>,
  input: { base?: HeldScenes | null; limits?: { partBytes: number }; showing?: string } = {},
): Array<Record<string, unknown>> {
  const sent: Array<Record<string, unknown>> = [];
  let base = input.base === undefined ? board.base : input.base;
  for (let part = 0; part < 200; part += 1) {
    const step = nextScenesPart(
      { id: "row", payload },
      base,
      { limits: input.limits, partId: `part-${part}`, showing: input.showing },
    );
    if (!step.ok) {
      throw new Error(step.error);
    }
    expect(Buffer.byteLength(JSON.stringify(step.message), "utf8")).toBeLessThanOrEqual(esp32MaxMessageBytes);
    expect(board.take(step.message)).toBeNull();
    // What the board reports is what the next part is worked out from.
    expect(board.applied).toBe(step.holds.checksum);
    expect(board.base).toEqual(step.holds);
    sent.push(step.message);
    if (step.final) {
      return sent;
    }
    base = step.holds;
  }
  throw new Error("never the last part");
}

describe("a set in parts", () => {
  it("sends a set over the cap as patches, each against the checksum the one before left", () => {
    // Held: five scenes. Pushed: three of them changed, one kept, one gone
    // (`old`), seven new: 1.1 MB of scenes to put.
    const board = new Board();
    const kept = scene("kept", 20);
    board.take({ checksum: "set-1", scenes: [scene("a", 10), scene("b", 10), kept, scene("c", 10), scene("old", 10)], type: "set_scenes" });
    const next = [
      scene("a", 100, { v: 2 }),
      scene("n1", 100),
      scene("b", 100, { v: 2 }),
      kept,
      scene("n2", 100),
      scene("c", 100, { v: 2 }),
      ...["n3", "n4", "n5", "n6", "n7"].map((id) => scene(id, 100)),
    ];
    const payload = { checksum: "set-2", scene_id: "n1", scenes: next, state: { city: "Brussels" } };
    const sent = deliver(board, payload, { showing: "kept" });

    expect(sent.length).toBeGreaterThan(2);
    // Every part is a patch, and none is over what a part aims at.
    for (const message of sent) {
      expect(message.type).toBe("scenes_patch");
      expect(Buffer.byteLength(JSON.stringify(message), "utf8")).toBeLessThanOrEqual(esp32ScenesPartBytes);
    }
    // The chain: set-1, then each part's own checksum, then the row's.
    expect(sent[0]?.base_checksum).toBe("set-1");
    for (let i = 1; i < sent.length; i += 1) {
      expect(sent[i]?.base_checksum).toBe(sent[i - 1]?.checksum);
    }
    const checksums = sent.map((message) => message.checksum);
    expect(new Set(checksums).size).toBe(sent.length);
    expect(checksums.at(-1)).toBe("set-2");
    expect(checksums.slice(0, -1)).not.toContain("set-2");
    expect(checksums).not.toContain("set-1");
    // The row's id, the scene to show and its values with the last part alone.
    const last = sent.at(-1);
    expect(last).toMatchObject({ id: "row", scene_id: "n1", state: { city: "Brussels" } });
    expect(last?.order).toEqual(next.map((entry) => entry.id));
    for (const message of sent.slice(0, -1)) {
      expect(message.id).not.toBe("row");
      expect(message.scene_id).toBeUndefined();
      expect(message.state).toBeUndefined();
      expect(message.scenes).toBeUndefined();
    }
    // A scene goes out once.
    const put = sent.flatMap((message) => (message.put as Array<{ id: string }>).map((entry) => entry.id));
    expect([...put].sort()).toEqual(next.filter((entry) => entry !== kept).map((entry) => entry.id).sort());
    // The frame holds exactly the row's set.
    expect(board.scenes).toEqual(next);
    expect(board.applied).toBe("set-2");
    // The scene the new set drops went with the first part: its room is free.
    expect(board.held[1]).not.toContain("old");
  });

  it("keeps the scene on the panel until the last part, and changes it with the last part", () => {
    // The panel shows a scene the new set drops.
    const dropped = new Board();
    dropped.take({ checksum: "set-1", scenes: [scene("showing", 10), scene("other", 10)], type: "set_scenes" });
    const next = ["n1", "n2", "n3", "n4", "n5", "n6"].map((id) => scene(id, 120));
    const sent = deliver(dropped, { checksum: "set-2", scenes: next }, { showing: "showing" });
    expect(sent.length).toBeGreaterThan(2);
    for (const ids of dropped.held.slice(0, -1)) {
      expect(ids).toContain("showing");
    }
    // The other scene it drops is gone at once.
    expect(dropped.held[1]).not.toContain("other");
    expect(dropped.held.at(-1)).toEqual(next.map((entry) => entry.id));
    // Nothing renders for the parts between: they name no scene to show and
    // leave the one showing as it was.
    for (const message of sent.slice(0, -1)) {
      expect(patchLeavesPanel(message, "showing")).toBe(true);
    }
    expect(patchLeavesPanel(sent.at(-1) as Record<string, unknown>, "showing")).toBe(false);

    // The panel shows a scene the new set changes: it is put with the last part.
    const changed = new Board();
    changed.take({ checksum: "set-1", scenes: [scene("showing", 10), scene("other", 10)], type: "set_scenes" });
    const edited = [scene("showing", 120, { v: 2 }), ...next];
    const parts = deliver(changed, { checksum: "set-2", scenes: edited }, { showing: "showing" });
    for (const message of parts.slice(0, -1)) {
      expect((message.put as Array<{ id: string }>).map((entry) => entry.id)).not.toContain("showing");
      expect(patchLeavesPanel(message, "showing")).toBe(true);
    }
    expect((parts.at(-1)?.put as Array<{ id: string }>).map((entry) => entry.id)).toContain("showing");
    expect(changed.scenes).toEqual(edited);
  });

  it("starts with a set_scenes of the scenes that fit when the frame's set is not known", () => {
    const board = new Board();
    board.take({ checksum: "local", scenes: [scene("showing", 10), scene("stale", 10)], type: "set_scenes" });
    const next = [scene("n1", 120), scene("n2", 120), scene("showing", 120), scene("n3", 120), scene("n4", 120)];
    const sent = deliver(board, { checksum: "set-2", scene_id: "n4", scenes: next }, { base: null, showing: "showing" });

    expect(sent.map((message) => message.type)).toEqual(["set_scenes", ...sent.slice(1).map(() => "scenes_patch")]);
    expect(sent.length).toBeGreaterThan(2);
    // The first part holds the scene on the panel, in the set's order.
    const first = (sent[0]?.scenes as Array<{ id: string }>).map((entry) => entry.id);
    expect(first).toContain("showing");
    expect(first).toEqual(next.map((entry) => entry.id).filter((id) => first.includes(id)));
    expect(sent[0]?.id).not.toBe("row");
    expect(sent[0]?.scene_id).toBeUndefined();
    expect(sent[1]?.base_checksum).toBe(sent[0]?.checksum);
    expect(sent.at(-1)).toMatchObject({ checksum: "set-2", id: "row", scene_id: "n4" });
    expect(board.scenes).toEqual(next);
    // Every set between is some of the new set's scenes.
    for (const ids of board.held.slice(1)) {
      expect(ids.every((id) => next.some((entry) => entry.id === id))).toBe(true);
    }
  });

  it("never holds more than 128 scenes on the way", () => {
    // 128 held, the one on the panel among them; 128 others pushed.
    const board = new Board();
    const old = Array.from({ length: 128 }, (_, i) => scene(`old-${i}`, 1));
    board.take({ checksum: "set-1", scenes: old, type: "set_scenes" });
    const next = Array.from({ length: 128 }, (_, i) => scene(`new-${i}`, 8));
    const sent = deliver(board, { checksum: "set-2", scenes: next }, { showing: "old-5" });
    expect(sent.length).toBeGreaterThan(3);
    for (const ids of board.held) {
      expect(ids.length).toBeLessThanOrEqual(esp32SceneStoreScenes);
    }
    for (const ids of board.held.slice(1, -1)) {
      expect(ids).toContain("old-5");
    }
    expect(board.scenes).toEqual(next);

    // A full set that keeps the scene on the panel for the last part has no
    // place for a new scene before it: 127 scenes changed and one new, first
    // in the order, which would otherwise go with the first part as the 129th.
    const full = new Board();
    const kept = Array.from({ length: 127 }, (_, i) => scene(`k-${i}`, 1));
    full.take({ checksum: "set-1", scenes: [scene("showing", 1), ...kept], type: "set_scenes" });
    const edited = [scene("new", 8), ...kept.map((entry) => scene(entry.id, 8, { v: 2 }))];
    const parts = deliver(full, { checksum: "set-2", scenes: edited }, { limits: { partBytes: 64 * 1024 }, showing: "showing" });
    expect(parts.length).toBeGreaterThan(10);
    for (const ids of full.held.slice(1, -1)) {
      expect(ids).toHaveLength(esp32SceneStoreScenes);
      expect(ids).toContain("showing");
      expect(ids).not.toContain("new");
    }
    expect((parts.at(-1)?.put as Array<{ id: string }>).map((entry) => entry.id)).toContain("new");
    expect(full.scenes).toEqual(edited);
  });

  it("sends a scene bigger than a part alone, and refuses a set with one no message holds", () => {
    const board = new Board();
    board.take({ checksum: "set-1", scenes: [scene("a", 1)], type: "set_scenes" });
    const next = [scene("a", 1), scene("s1", 60), scene("big", 400), scene("s2", 60), scene("s3", 60), scene("s4", 150)];
    const sent = deliver(board, { checksum: "set-2", scenes: next });
    const alone = sent.find((message) => (message.put as Array<{ id: string }>).some((entry) => entry.id === "big"));
    expect(alone?.put).toHaveLength(1);
    expect(board.scenes).toEqual(next);

    // Over the cap by itself: nothing is sent, the first call says so.
    const tooBig = { checksum: "set-3", scenes: [...next, scene("huge", 513)] };
    expect(nextScenesPart({ id: "row", payload: tooBig }, board.base, { partId: "p" })).toEqual({
      error: "payload_too_large",
      ok: false,
    });
    expect(nextScenesPart({ id: "row", payload: tooBig }, null, { partId: "p" })).toEqual({
      error: "payload_too_large",
      ok: false,
    });
    // A scene that big the frame holds already is not sent, so it is no reason.
    const withHuge = new Board();
    withHuge.scenes = [scene("huge", 513)];
    withHuge.applied = "set-0";
    deliver(withHuge, { checksum: "set-4", scenes: [scene("huge", 513), ...next] });
    expect(withHuge.scenes.map((entry) => entry.id)).toEqual(["huge", ...next.map((entry) => entry.id)]);
  });

  it("refuses a set of more scenes than a board holds, and a list it cannot name", () => {
    const many = Array.from({ length: 129 }, (_, i) => scene(`s-${i}`, 5));
    expect(nextScenesPart({ id: "row", payload: { checksum: "n", scenes: many } }, null, { partId: "p" })).toEqual({
      error: "too_many_scenes",
      ok: false,
    });
    expect(
      nextScenesPart({ id: "row", payload: { checksum: "n", scenes: [{ name: "no id" }] } }, null, { partId: "p" }),
    ).toMatchObject({ ok: false });
    expect(nextScenesPart({ id: "row", payload: { scenes: [scene("a", 1)] } }, null, { partId: "p" })).toMatchObject({
      ok: false,
    });
  });

  it("gives the same part for the same row and set held, so a part sent twice is one change", () => {
    const board = new Board();
    board.take({ checksum: "set-1", scenes: [scene("a", 10)], type: "set_scenes" });
    const payload = { checksum: "set-2", scenes: ["n1", "n2", "n3", "n4", "n5"].map((id) => scene(id, 120)) };
    const one = nextScenesPart({ id: "row", payload }, board.base, { partId: "p1", showing: "a" });
    const two = nextScenesPart({ id: "row", payload }, board.base, { partId: "p2", showing: "a" });
    expect(one.ok && two.ok && one.holds).toEqual(two.ok && two.holds);
    expect(one.ok && { ...one.message, id: "" }).toEqual(two.ok && { ...two.message, id: "" });
    // Taken twice: the second is against a checksum the board no longer
    // holds, and its own it holds already, so the board acks it unchanged.
    expect(board.take(one.ok ? one.message : {})).toBeNull();
    const after = board.scenes;
    expect(board.take(two.ok ? two.message : {})).toBeNull();
    expect(board.scenes).toBe(after);
  });

  it("is one message when all that is left fits, with the hub's own keys left out", () => {
    const base = { checksum: "old", hashes: sceneHashes([a, b]) as Record<string, string> };
    const changed = { ...b, name: "B2" };
    const step = nextScenesPart(
      {
        id: "cmd",
        payload: {
          checksum: "new",
          no_patch: true,
          part: { checksum: "x", hashes: {} },
          scene_hashes: { x: "y" },
          scene_id: "b",
          scenes: [a, changed],
        },
      },
      base,
      { partId: "p" },
    );
    expect(step).toEqual({
      final: true,
      holds: { checksum: "new", hashes: sceneHashes([a, changed]) },
      message: {
        base_checksum: "old",
        checksum: "new",
        id: "cmd",
        order: ["a", "b"],
        put: [changed],
        scene_id: "b",
        type: "scenes_patch",
      },
      ok: true,
    });
    // The single patch leaves them out too.
    expect(
      buildScenesPatchMessage({ id: "cmd", payload: { checksum: "new", part: { checksum: "x" }, scenes: [a, changed] } }, base),
    ).not.toHaveProperty("part");
  });

  it("reads back what a row keeps of its parts", () => {
    const held = { checksum: "c", hashes: { a: "1" } };
    expect(scenesPartRecord({ ...held, accepted: 2, from: { checksum: "b", hashes: {} } })).toEqual({
      ...held,
      accepted: 2,
      from: { checksum: "b", hashes: {} },
    });
    expect(scenesPartRecord(held)).toEqual(held);
    expect(scenesPartRecord({ checksum: "c" })).toBeNull();
    expect(scenesPartRecord({ checksum: "c", hashes: { a: 1 } })).toBeNull();
    expect(scenesPartRecord(undefined)).toBeNull();
  });
});

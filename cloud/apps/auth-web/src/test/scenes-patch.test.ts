import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildScenesPatchMessage,
  esp32SceneStoreSlots,
  esp32SceneStoreSlotsBefore,
  esp32SceneStoreSlotsFor,
  esp32SceneStoreSlotsVersion,
  patchLeavesPanel,
  sceneHashes,
} from "../lib/scenes-patch";

describe("scenes_patch and the board's slots", () => {
  it("counts the firmware's slots", () => {
    const header = readFileSync(join(__dirname, "../../../../../embedded/esp32/main/fos_scene_store.h"), "utf8");
    expect(Number(/#define\s+FOS_SCENE_STORE_SLOTS\s+(\d+)/.exec(header)?.[1])).toBe(esp32SceneStoreSlots);
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

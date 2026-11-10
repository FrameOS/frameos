import { describe, expect, it } from "vitest";

import { buildScenesPatchMessage, sceneHashes } from "../lib/scenes-patch";

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
});

// What a board the cloud renders for is sent (docs/server-rendering.md
// "Nothing to keep on the board").
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { messageForServerRenderedBoard, serverRenderedBoardScene } from "./cloud-rendered";

describe("serverRenderedBoardScene", () => {
  it("is the corpus the backend sends too", () => {
    const corpus = JSON.parse(
      readFileSync(new URL("../../../../../docs/server-rendered-board-scene.json", import.meta.url), "utf8"),
    ) as { scene: unknown };
    expect(serverRenderedBoardScene).toEqual(corpus.scene);
  });
});

describe("messageForServerRenderedBoard", () => {
  const scene = { fields: [{ name: "token", value: "field-secret" }], id: "a", nodes: [] };

  it("sends a scene set, whole or a patch, as the empty scene under its checksum", () => {
    const whole = messageForServerRenderedBoard({
      checksum: "set-1",
      id: "c1",
      preview: { scene, scene_id: "a" },
      scene_id: "a",
      scenes: [scene],
      state: { token: "state-secret" },
      type: "set_scenes",
    });
    expect(whole).toEqual({ checksum: "set-1", id: "c1", scene_id: "a", scenes: [serverRenderedBoardScene], type: "set_scenes" });
    const patch = messageForServerRenderedBoard({
      base_checksum: "set-1",
      checksum: "set-2",
      id: "c2",
      order: ["a"],
      put: [scene],
      type: "scenes_patch",
    });
    expect(patch).toEqual({ checksum: "set-2", id: "c2", scenes: [serverRenderedBoardScene], type: "set_scenes" });
    expect(JSON.stringify([whole, patch])).not.toMatch(/secret/);
  });

  it("drops a switch's state and an event's payload, and leaves every other verb", () => {
    expect(
      messageForServerRenderedBoard({ id: "c3", scene_id: "a", state: { token: "state-secret" }, type: "set_current_scene" }),
    ).toEqual({ id: "c3", scene_id: "a", type: "set_current_scene" });
    expect(
      messageForServerRenderedBoard({ id: "c4", name: "setSceneState", payload: { state: { token: "s" } }, type: "scene_event" }),
    ).toEqual({ id: "c4", name: "setSceneState", payload: {}, type: "scene_event" });
    const settings = { id: "c5", settings: { interval: 600 }, type: "set_settings" };
    expect(messageForServerRenderedBoard(settings)).toBe(settings);
  });
});

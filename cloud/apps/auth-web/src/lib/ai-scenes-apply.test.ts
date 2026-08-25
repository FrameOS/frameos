import { describe, expect, it } from "vitest";
import { applyAiScenes, blankScene, isBlankStarter, prepareForEditor, type SceneJson } from "./ai-scenes-apply";

const current: SceneJson[] = [
  { id: "a", name: "A" },
  { id: "b", name: "B" },
];

describe("prepareForEditor", () => {
  it("gives every node a position and asks the editor to auto-arrange", () => {
    const scene = prepareForEditor({
      id: "s",
      nodes: [{ id: "n1", type: "event" }, { id: "n2", position: { x: 5, y: 6 }, type: "app" }],
      settings: { execution: "interpreted" },
    });
    expect(scene.nodes).toEqual([
      { id: "n1", position: { x: -9999, y: -9999 }, type: "event" },
      { id: "n2", position: { x: 5, y: 6 }, type: "app" },
    ]);
    expect(scene.settings).toEqual({ autoArrangeOnLoad: true, execution: "interpreted" });
  });

  it("replaces the blank starter scene instead of keeping it as a stray tab", () => {
    const starter = blankScene();
    expect(isBlankStarter(starter)).toBe(true);
    const result = applyAiScenes(
      [starter],
      { scenes: [{ id: "built", name: "Built", nodes: [{ id: "x", type: "event" }] }], tool: "build_scene", type: "scenes" },
      starter.id,
    );
    expect(result.scenes.map((scene) => scene.id)).toEqual(["built"]);
    expect(result.selectedSceneId).toBe("built");
  });
});

describe("applyAiScenes", () => {
  it("replaces the scene with the same id on modify_scene, with a new array identity", () => {
    const result = applyAiScenes(
      current,
      { scenes: [{ id: "b", name: "B2" }], tool: "modify_scene", type: "scenes" },
      "a",
    );
    expect(result.scenes).not.toBe(current);
    expect(result.scenes).toEqual([
      { id: "a", name: "A" },
      { id: "b", name: "B2", nodes: undefined, settings: { autoArrangeOnLoad: true } },
    ]);
    expect(result.selectedSceneId).toBe("b");
  });

  it("falls back to replacing the selected scene when the id is unknown", () => {
    const result = applyAiScenes(
      current,
      { scenes: [{ id: "zzz", name: "Renamed" }], tool: "modify_scene", type: "scenes" },
      "a",
    );
    expect(result.scenes.map((scene) => scene.id)).toEqual(["zzz", "b"]);
    expect(result.selectedSceneId).toBe("zzz");
  });

  it("appends new scenes on build_scene and selects the first, dodging id collisions", () => {
    const result = applyAiScenes(
      current,
      {
        scenes: [
          { id: "a", name: "Fresh" },
          { id: "c", name: "Second" },
        ],
        tool: "build_scene",
        type: "scenes",
      },
      "a",
    );
    expect(result.scenes).toHaveLength(4);
    expect(result.scenes.slice(0, 2)).toEqual(current);
    const fresh = result.scenes[2]!;
    expect(fresh.name).toBe("Fresh");
    expect(fresh.id).not.toBe("a");
    expect(result.scenes[3]).toMatchObject({ id: "c", name: "Second", settings: { autoArrangeOnLoad: true } });
    expect(result.selectedSceneId).toBe(fresh.id);
  });

  it("ignores empty or malformed payloads", () => {
    const result = applyAiScenes(current, { scenes: [], tool: "build_scene", type: "scenes" }, "b");
    expect(result.scenes).toEqual(current);
    expect(result.selectedSceneId).toBe("b");
  });
});

describe("blankScene", () => {
  it("is one interpreted scene with a render event", () => {
    const scene = blankScene();
    expect(scene.name).toBe("New scene");
    expect(scene.settings).toEqual({ execution: "interpreted" });
    expect(scene.nodes).toEqual([
      expect.objectContaining({ data: { keyword: "render" }, type: "event" }),
    ]);
    expect(scene.edges).toEqual([]);
    expect(scene.fields).toEqual([]);
  });
});

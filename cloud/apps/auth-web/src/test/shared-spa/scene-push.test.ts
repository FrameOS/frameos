import { describe, expect, it } from "vitest";
import type { FrameScene } from "../../../../../../frontend/src/types";
import {
  connectedSceneIds,
  savedScenesWithPushed,
  scenePushActionCopy,
  scenePushSceneIds,
} from "../../../../../../frontend/src/utils/scenePush";

// The scene drawer's push (docs/ui-vocabulary.md "Push"): the scene and the
// connected scenes with changes, and nothing else.

function scene(id: string, nodes: object[] = [], name = id): FrameScene {
  return { id, name, nodes, edges: [] } as unknown as FrameScene;
}

const panel = (keyword: string) => ({ id: `n-${keyword}`, type: "scene", data: { keyword } });
const switchTo = (sceneId: string) => ({
  id: `d-${sceneId}`,
  type: "dispatch",
  data: { keyword: "setCurrentScene", config: { sceneId } },
});

describe("scenePush", () => {
  const split = scene("split", [panel("left"), panel("right")]);
  const left = scene("left", [switchTo("detail")]);
  const right = scene("right");
  const detail = scene("detail");
  const unrelated = scene("unrelated");
  const scenes = [split, left, right, detail, unrelated];

  it("follows scene nodes and setCurrentScene targets, transitively, root first", () => {
    expect(connectedSceneIds("split", scenes)).toEqual(["split", "left", "detail", "right"]);
    expect(connectedSceneIds("right", scenes)).toEqual(["right"]);
  });

  it("does not loop on scenes that reach each other", () => {
    const a = scene("a", [panel("b")]);
    const b = scene("b", [switchTo("a")]);
    expect(connectedSceneIds("a", [a, b])).toEqual(["a", "b"]);
  });

  it("pushes the connected scenes with changes, never an unrelated one", () => {
    const changed = new Set(["split", "detail", "unrelated"]);
    expect(scenePushSceneIds("split", scenes, changed)).toEqual(["split", "detail"]);
  });

  it("merges the pushed edits into the saved list and leaves every other edit out", () => {
    const saved = [scene("split", [], "old split"), scene("unrelated", [], "saved unrelated")];
    const form = [
      scene("split", [], "new split"),
      scene("unrelated", [], "edited unrelated"),
      scene("brand-new", [], "new panel"),
    ];
    const merged = savedScenesWithPushed(saved, form, ["split", "brand-new"]);
    expect(merged.map((s) => [s.id, s.name])).toEqual([
      ["split", "new split"],
      ["unrelated", "saved unrelated"],
      ["brand-new", "new panel"],
    ]);
  });

  it("names the drawer's main action for what it does", () => {
    expect(scenePushActionCopy({ active: false, connected: 0, saves: true })).toEqual({
      label: "Push & activate",
      description: "Save and push this scene to the frame, then show it",
    });
    expect(scenePushActionCopy({ active: true, connected: 2, saves: false })).toEqual({
      label: "Push to frame",
      description: "Push this scene and 2 connected scenes to the frame",
    });
  });
});

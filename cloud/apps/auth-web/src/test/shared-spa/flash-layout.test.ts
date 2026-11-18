// The layout a frame starts with, chosen where its card or board is flashed
// (docs/scene-layouts.md "Chosen at the flash", frontend/src/utils/flashLayout.ts).
import { describe, expect, it } from "vitest";
import { LAYOUT_STARTERS } from "../../../../../../frontend/src/generated/layoutStarters";
import type { FrameScene } from "../../../../../../frontend/src/types";
import {
  NO_FLASH_LAYOUT,
  flashLayoutPick,
  flashLayoutScene,
  flashLayoutStartingState,
  frameLayoutChoice,
  initialFlashLayoutChoice,
  installedLayoutCopy,
  scenesWithFlashLayout,
  starterLayoutChoice,
  withStateAsFieldDefaults,
} from "../../../../../../frontend/src/utils/flashLayout";
import {
  activeFrameLayout,
  layoutForNewScenes,
  withActiveLayoutOnNewScenes,
} from "../../../../../../frontend/src/utils/sceneLayouts";

const clock = { id: "clock", name: "Clock", nodes: [], edges: [] } as unknown as FrameScene;
const photos = { id: "photos", name: "Photos", nodes: [], edges: [] } as unknown as FrameScene;
const desk = {
  id: "desk",
  name: "Desk",
  nodes: [],
  edges: [],
  settings: { isLayout: true, desktop: true },
  fields: [
    { name: "look", type: "select", value: "frameos", access: "public", options: ["frameos", "contrast"] },
    { name: "clock", type: "boolean", value: "true", access: "public" },
  ],
} as unknown as FrameScene;
const starter = { name: "Starter desk", scene: { ...desk, id: "starter-desk", name: "Starter desk", default: true } };
const ids = (() => {
  let next = 0;
  return () => `new-${++next}`;
})();

describe("the flash's layout choice", () => {
  it("starts on the layout the frame wears, else none", () => {
    expect(initialFlashLayoutChoice([])).toBe(NO_FLASH_LAYOUT);
    expect(initialFlashLayoutChoice([clock, desk])).toBe(NO_FLASH_LAYOUT);
    const wearing = { ...clock, layout: { sceneId: "desk", state: { look: "contrast" } } };
    expect(initialFlashLayoutChoice([wearing, desk])).toBe(frameLayoutChoice("desk"));
    expect(flashLayoutStartingState(frameLayoutChoice("desk"), [wearing, desk])).toEqual({ look: "contrast" });
    expect(flashLayoutStartingState(starterLayoutChoice("Starter desk"), [wearing, desk])).toEqual({});
  });

  it("names the frame's layouts and the starters", () => {
    expect(flashLayoutScene(frameLayoutChoice("desk"), [clock, desk], [starter])).toBe(desk);
    expect(flashLayoutScene(frameLayoutChoice("clock"), [clock, desk], [starter])).toBeNull();
    expect(flashLayoutScene(starterLayoutChoice("Starter desk"), [], [starter])).toBe(starter.scene);
    expect(flashLayoutPick(NO_FLASH_LAYOUT, {}, [], [])).toEqual({ kind: "none" });
    expect(flashLayoutPick(starterLayoutChoice("Gone"), {}, [], [starter])).toBeNull();
  });

  it("offers every repository layout as a starter", () => {
    expect(LAYOUT_STARTERS.length).toBeGreaterThan(0);
    for (const entry of LAYOUT_STARTERS) {
      expect(entry.scene.settings?.isLayout).toBe(true);
      expect(flashLayoutScene(starterLayoutChoice(entry.name), [], LAYOUT_STARTERS)).toBe(entry.scene);
    }
  });
});

describe("scenesWithFlashLayout", () => {
  it("installs a starter's copy, worn by every scene, with the gear's values as its defaults", () => {
    const state = { look: "contrast" };
    const pick = flashLayoutPick(starterLayoutChoice("Starter desk"), state, [clock, photos], [starter])!;
    const scenes = scenesWithFlashLayout([clock, photos], pick, () => "copy");
    expect(scenes.map((scene) => scene.id)).toEqual(["clock", "photos", "copy"]);
    expect(scenes[0]?.layout).toEqual({ sceneId: "copy", state });
    expect(scenes[1]?.layout).toEqual({ sceneId: "copy", state });
    const copy = scenes[2]!;
    expect(copy.default).toBeUndefined();
    expect(copy.layout).toBeUndefined();
    expect(copy.fields?.find((field) => field.name === "look")?.value).toBe("contrast");
    expect(copy.fields?.find((field) => field.name === "clock")?.value).toBe("true");
    // The frame wears it now, as its own Layout select would have left it.
    expect(activeFrameLayout(scenes)).toEqual({ sceneId: "copy", state });
  });

  it("wears a layout of that name the frame already has instead of adding it twice", () => {
    const named = { ...desk, name: "Starter desk" };
    const pick = flashLayoutPick(starterLayoutChoice("Starter desk"), {}, [clock, named], [starter])!;
    const scenes = scenesWithFlashLayout([clock, named], pick, ids);
    expect(scenes.map((scene) => scene.id)).toEqual(["clock", "desk"]);
    expect(scenes[0]?.layout).toEqual({ sceneId: "desk" });
  });

  it("puts one of the frame's layouts on every scene, or takes them all off", () => {
    const wearing = { ...clock, layout: { sceneId: "desk" } };
    const frame = flashLayoutPick(frameLayoutChoice("desk"), { clock: "false" }, [wearing, photos, desk], [])!;
    const dressed = scenesWithFlashLayout([wearing, photos, desk], frame, ids);
    expect(dressed[1]?.layout).toEqual({ sceneId: "desk", state: { clock: "false" } });
    expect(dressed[2]).toBe(desk);
    const none = scenesWithFlashLayout(dressed, { kind: "none" }, ids);
    expect(none.some((scene) => "layout" in scene)).toBe(false);
    expect(none.map((scene) => scene.id)).toEqual(["clock", "photos", "desk"]);
  });

  it("leaves a frame with no scenes holding the layout, which the first scenes to join wear", () => {
    const pick = flashLayoutPick(starterLayoutChoice("Starter desk"), { look: "contrast" }, [], [starter])!;
    const scenes = scenesWithFlashLayout([], pick, () => "copy");
    expect(scenes.map((scene) => scene.id)).toEqual(["copy"]);
    expect(layoutForNewScenes(scenes)).toEqual({ sceneId: "copy" });
    expect(withActiveLayoutOnNewScenes(scenes, [{ id: "new" }])).toEqual([{ id: "new", layout: { sceneId: "copy" } }]);
    // Two layouts and nothing else: no telling which one was meant.
    expect(layoutForNewScenes([...scenes, desk])).toBeNull();
  });

  it("copies a starter without the stamps of the repository's scene", () => {
    const copy = installedLayoutCopy({ ...starter.scene, origin: { repository: "x" } } as FrameScene, {}, "id-1");
    expect(copy.id).toBe("id-1");
    expect(copy).not.toHaveProperty("origin");
    expect(copy).not.toHaveProperty("default");
    expect(withStateAsFieldDefaults(clock, { look: "x" })).toBe(clock);
  });
});

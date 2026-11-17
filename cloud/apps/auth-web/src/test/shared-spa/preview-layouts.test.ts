// The live preview's Layout select (docs/scene-layouts.md "In the preview").
import { describe, expect, it } from "vitest";
import {
  layoutSettingAppliesAtOnce,
  loadLayoutStarters,
  parsePreviewLayoutSettings,
  previewLayoutGroups,
  previewLayouts,
  previewLayoutScene,
  scenesWithPreviewLayout,
  withoutPreviewLayoutSettings,
  withPreviewLayoutSetting,
  wornPreviewLayout,
  wornPreviewLayoutState,
} from "../../../../../../frontend/src/sceneWorkspace/lib/preview-layouts";

const starter = (id: string, name: string) => ({
  name,
  scene: { id, name, nodes: [], settings: { isLayout: true } },
});
const starters = [starter("layout-windows-98", "Windows 98"), starter("layout-top-bar", "Top bar")];

describe("previewLayouts", () => {
  it("offers the scenes' own layouts first, then every starter they do not already hold", () => {
    const scenes = [
      { id: "clock", name: "Clock" },
      { id: "mine", name: "Windows 98", settings: { isLayout: true } },
      { id: "layout-top-bar", name: "Renamed bar", settings: { isLayout: true } },
    ];
    expect(previewLayouts(scenes, starters).map(({ id, name, starter }) => [id, name, starter !== null])).toEqual([
      ["mine", "Windows 98", false],
      ["layout-top-bar", "Renamed bar", false],
    ]);
    expect(previewLayouts([{ id: "clock" }], starters).map((layout) => layout.id)).toEqual([
      "layout-windows-98",
      "layout-top-bar",
    ]);
  });

  it("lists the desktops apart from the full screen layouts, the scenes' own first in each", () => {
    const desktop = { name: "Tiling", scene: { id: "layout-tiling", nodes: [], settings: { isLayout: true, desktop: true } } };
    const scenes = [
      { id: "clock", name: "Clock" },
      { id: "bar", name: "My bar", settings: { isLayout: true } },
      { id: "desk", name: "My desk", settings: { isLayout: true, desktop: true } },
    ];
    const groups = previewLayoutGroups(previewLayouts(scenes, [...starters, desktop]));
    expect(groups.map((group) => [group.title, group.items.map((layout) => layout.id)])).toEqual([
      ["Desktops", ["desk", "layout-tiling"]],
      ["Full screen", ["bar", "layout-windows-98", "layout-top-bar"]],
    ]);
    expect(previewLayoutGroups(previewLayouts([{ id: "clock" }], starters)).map((group) => group.title)).toEqual([
      "Full screen",
    ]);
  });

  it("lists every layout starter the repository has", async () => {
    const all = await loadLayoutStarters();
    const names = previewLayouts([{ id: "clock" }], all).map((layout) => layout.name);
    expect(names).toEqual(expect.arrayContaining(["Windows 98", "Top bar", "Bottom bar", "Side rail"]));
  });
});

describe("wornPreviewLayout", () => {
  it("reads the layout a scene wears, none when the scenes do not hold it", () => {
    const scenes = [
      { id: "clock", layout: { sceneId: "chrome" } },
      { id: "photos", layout: { sceneId: "gone" } },
      { id: "chrome", settings: { isLayout: true } },
    ];
    expect(wornPreviewLayout(scenes, "clock")).toBe("chrome");
    expect(wornPreviewLayout(scenes, "photos")).toBe("");
    expect(wornPreviewLayout(scenes, "missing")).toBe("");
  });
});

describe("scenesWithPreviewLayout", () => {
  const scenes = [
    { id: "clock", nodes: [], layout: { sceneId: "chrome", state: { height: 40 } } },
    { id: "photos", nodes: [] },
    { id: "chrome", nodes: [], settings: { isLayout: true } },
  ];

  it("puts a starter on every scene and runs its scene beside them", () => {
    const layouts = previewLayouts(scenes, starters);
    const ran = scenesWithPreviewLayout(scenes, layouts, "layout-windows-98");
    expect(ran.map((scene) => [scene.id, scene.layout])).toEqual([
      ["clock", { sceneId: "layout-windows-98" }],
      ["photos", { sceneId: "layout-windows-98" }],
      ["chrome", undefined],
      ["layout-windows-98", undefined],
    ]);
    // What the editor holds is left as it was.
    expect(scenes[0]!.layout).toEqual({ sceneId: "chrome", state: { height: 40 } });
  });

  it("keeps a scene's settings for the layout it already wears, and takes every layout off for none", () => {
    const layouts = previewLayouts(scenes, starters);
    expect(scenesWithPreviewLayout(scenes, layouts, "chrome").map((scene) => scene.layout)).toEqual([
      { sceneId: "chrome", state: { height: 40 } },
      { sceneId: "chrome" },
      undefined,
    ]);
    for (const none of ["", "not-offered"]) {
      const ran = scenesWithPreviewLayout(scenes, layouts, none);
      expect(ran.map((scene) => scene.id)).toEqual(["clock", "photos", "chrome"]);
      expect(ran.every((scene) => !("layout" in scene))).toBe(true);
    }
  });
});

describe("the preview's Layout settings", () => {
  const scenes = [
    { id: "clock", nodes: [], layout: { sceneId: "chrome", state: { height: 40, title: "Clock" } } },
    { id: "photos", nodes: [], layout: { sceneId: "chrome" } },
    { id: "notes", nodes: [] },
    { id: "chrome", nodes: [], settings: { isLayout: true } },
  ];
  const layouts = previewLayouts(scenes, starters);

  it("go over the state each scene gives the layout it wears, and leave the scenes as they were when none apply", () => {
    const settings = { chrome: { title: "Home", dark: true }, "layout-top-bar": { title: "Bar" } };
    expect(scenesWithPreviewLayout(scenes, layouts, null, settings).map((scene) => scene.layout)).toEqual([
      { sceneId: "chrome", state: { height: 40, title: "Home", dark: true } },
      { sceneId: "chrome", state: { title: "Home", dark: true } },
      undefined,
      undefined,
    ]);
    expect(scenes[0]!.layout).toEqual({ sceneId: "chrome", state: { height: 40, title: "Clock" } });
    // Nothing for the layouts worn: the very list, so the runtime is not booted again.
    expect(scenesWithPreviewLayout(scenes, layouts, null, { "layout-top-bar": { title: "Bar" } })).toBe(scenes);
    expect(scenesWithPreviewLayout(scenes, layouts, null)).toBe(scenes);
  });

  it("go on every scene with the layout chosen, a starter's included", () => {
    const ran = scenesWithPreviewLayout(scenes, layouts, "layout-top-bar", { "layout-top-bar": { title: "Bar" } });
    expect(ran.map((scene) => [scene.id, scene.layout])).toEqual([
      ["clock", { sceneId: "layout-top-bar", state: { title: "Bar" } }],
      ["photos", { sceneId: "layout-top-bar", state: { title: "Bar" } }],
      ["notes", { sceneId: "layout-top-bar", state: { title: "Bar" } }],
      ["chrome", undefined],
      ["layout-top-bar", undefined],
    ]);
    expect(scenesWithPreviewLayout(scenes, layouts, "chrome", { chrome: { title: "Home" } })[0]!.layout).toEqual({
      sceneId: "chrome",
      state: { height: 40, title: "Home" },
    });
    const none = scenesWithPreviewLayout(scenes, layouts, "", { chrome: { title: "Home" } });
    expect(none.every((scene) => !("layout" in scene))).toBe(true);
  });

  it("find the layout's scene and what the shown scene gives it", () => {
    expect(previewLayoutScene(scenes, layouts, "chrome")).toBe(scenes[3]);
    expect(previewLayoutScene(scenes, layouts, "layout-top-bar")).toBe(starters[1]!.scene);
    expect(previewLayoutScene(scenes, layouts, "clock")).toBeNull();
    expect(wornPreviewLayoutState(scenes, "clock", "chrome")).toEqual({ height: 40, title: "Clock" });
    expect(wornPreviewLayoutState(scenes, "photos", "chrome")).toEqual({});
    expect(wornPreviewLayoutState(scenes, "clock", "layout-top-bar")).toEqual({});
    expect(wornPreviewLayoutState(scenes, null, "chrome")).toEqual({});
  });

  it("are kept per layout, and read back from storage whatever it holds", () => {
    const one = withPreviewLayoutSetting({}, "chrome", "title", "Home");
    const two = withPreviewLayoutSetting(one, "chrome", "dark", true);
    expect(two).toEqual({ chrome: { title: "Home", dark: true } });
    expect(one).toEqual({ chrome: { title: "Home" } });
    expect(withoutPreviewLayoutSettings(two, "chrome")).toEqual({});
    expect(withoutPreviewLayoutSettings(two, "other")).toBe(two);

    expect(parsePreviewLayoutSettings(JSON.stringify(two))).toEqual(two);
    for (const stored of [null, "", "undefined", "[1]", '"text"', "{not json"]) {
      expect(parsePreviewLayoutSettings(stored)).toEqual({});
    }
    const mixed = JSON.stringify({ chrome: { a: 1 }, bad: [1], empty: {}, none: null });
    expect(parsePreviewLayoutSettings(mixed)).toEqual({ chrome: { a: 1 } });
  });

  it("reach the preview at once from a checkbox or a menu, after a pause from typing", () => {
    expect(["boolean", "select", "font"].map(layoutSettingAppliesAtOnce)).toEqual([true, true, true]);
    const typed = ["string", "text", "integer", "float", "color", "json", undefined];
    expect(typed.map(layoutSettingAppliesAtOnce)).toEqual(typed.map(() => false));
  });
});

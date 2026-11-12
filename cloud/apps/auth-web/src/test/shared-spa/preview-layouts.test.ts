// The live preview's Layout select (docs/scene-layouts.md "In the preview").
import { describe, expect, it } from "vitest";
import {
  loadLayoutStarters,
  previewLayouts,
  scenesWithPreviewLayout,
  wornPreviewLayout,
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

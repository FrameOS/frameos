// Layouts (docs/scene-layouts.md): marked `settings.isLayout`, kept out of the
// scene lists, and worn per install through `layout` beside `nodes`.
import { describe, expect, it } from "vitest";
import {
  currentSceneLayout,
  isLayoutScene,
  layoutScenes,
  mainScene,
  sceneLayoutRef,
  scenesWithoutLayouts,
  withIsLayout,
  withSceneLayout,
  withoutSceneLayout,
} from "../../../../../../frontend/src/utils/sceneLayouts";
import type { FrameScene } from "../../../../../../frontend/src/types";

const clock = { id: "clock", name: "Clock", nodes: [], edges: [] } as unknown as FrameScene;
const bar = {
  id: "bar",
  name: "Bar",
  nodes: [],
  edges: [],
  settings: { isLayout: true },
} as unknown as FrameScene;

describe("layout scenes", () => {
  it("are told apart by their settings alone", () => {
    expect(isLayoutScene(bar)).toBe(true);
    expect(isLayoutScene(clock)).toBe(false);
    expect(isLayoutScene(null)).toBe(false);
    expect(scenesWithoutLayouts([clock, bar])).toEqual([clock]);
    expect(layoutScenes([clock, bar])).toEqual([bar]);
    expect(scenesWithoutLayouts(undefined)).toEqual([]);
  });

  it("switch to a normal scene and back, and a normal scene carries no flag", () => {
    expect(withIsLayout({ refreshInterval: 1 }, true)).toEqual({ refreshInterval: 1, isLayout: true });
    expect(withIsLayout({ refreshInterval: 1, isLayout: true }, false)).toEqual({ refreshInterval: 1 });
    expect(withIsLayout(undefined, false)).toEqual({});
  });

  it("are found in a saved pack by the scene it starts on, else the first", () => {
    const starts = { ...clock, default: true };
    expect(mainScene([bar, starts])).toBe(starts);
    expect(mainScene([bar, clock])).toBe(bar);
    expect(mainScene([])).toBeNull();
    expect(mainScene(undefined)).toBeNull();
  });

  it("are chosen per install", () => {
    const wearing = withSceneLayout(clock, { sceneId: "bar", state: { height: 40 } });
    expect(wearing.layout).toEqual({ sceneId: "bar", state: { height: 40 } });
    expect(withSceneLayout(wearing, null)).not.toHaveProperty("layout");
    expect(withoutSceneLayout(wearing)).not.toHaveProperty("layout");
    expect(withoutSceneLayout(clock)).toBe(clock);
  });

  it("read as none once the frame no longer has them", () => {
    const wearing = withSceneLayout(clock, { sceneId: "bar" });
    expect(currentSceneLayout(wearing, [bar])).toEqual({ sceneId: "bar" });
    expect(currentSceneLayout(wearing, [])).toBeNull();
    expect(currentSceneLayout(clock, [bar])).toBeNull();
  });

  it("normalize what the wire carries", () => {
    expect(sceneLayoutRef({ sceneId: "bar", state: {} })).toEqual({ sceneId: "bar" });
    expect(sceneLayoutRef({ sceneId: "" })).toBeNull();
    expect(sceneLayoutRef("bar")).toBeNull();
  });
});

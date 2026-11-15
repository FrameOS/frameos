// Layouts (docs/scene-layouts.md): marked `settings.isLayout`, kept out of the
// scene lists, and worn per install through `layout` beside `nodes`.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LAYOUT_STARTERS } from "../../../../../../frontend/src/generated/layoutStarters";
import {
  activeFrameLayout,
  currentSceneLayout,
  isLayoutScene,
  layoutScenes,
  mainScene,
  sceneLayoutProblem,
  sceneLayoutProblemText,
  sceneLayoutRef,
  scenesWithoutLayouts,
  layoutsWornBy,
  withActiveLayoutOnNewScenes,
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

describe("what can be a layout", () => {
  const { cases } = JSON.parse(
    readFileSync(new URL("../../../../../../docs/scene-layout-fixtures.json", import.meta.url), "utf8"),
  ) as { cases: { name: string; scene: unknown; problem: string | null }[] };

  it.each(cases)("$name", ({ scene, problem }) => {
    expect(sceneLayoutProblem(scene)).toBe(problem);
  });

  it("says why in words", () => {
    expect(sceneLayoutProblemText(cases.find((c) => c.problem === null)!.scene)).toBeNull();
    expect(sceneLayoutProblemText(cases.find((c) => c.problem === "yield")!.scene)).toContain("<yield />");
  });

  it("has starters, and every one of them is a layout", () => {
    expect(LAYOUT_STARTERS.map((starter) => starter.name)).toEqual([
      "macOS",
      "Windows 98",
      "Top bar",
      "Tiling",
      "Terminal",
      "Side rail",
      "Polaroid",
      "Gallery wall",
      "Front page",
      "Bottom bar",
      "BeOS",
    ]);
    for (const starter of LAYOUT_STARTERS) {
      expect(isLayoutScene(starter.scene)).toBe(true);
      expect(sceneLayoutProblem(starter.scene)).toBeNull();
      expect(starter.image).toMatch(/^data:image\/jpeg;base64,/);
    }
  });
});

describe("the frame's active layout", () => {
  const layout = { id: "bar", settings: { isLayout: true } };
  const wearing = (id: string, state?: Record<string, unknown>) => ({
    id,
    layout: state ? { sceneId: "bar", state } : { sceneId: "bar" },
  });

  it("is the one every scene wears, with the first scene's settings", () => {
    expect(activeFrameLayout([wearing("a", { height: 40 }), wearing("b"), layout])).toEqual({
      sceneId: "bar",
      state: { height: 40 },
    });
  });

  it("is none while the scenes differ, wear none, or there are none", () => {
    expect(activeFrameLayout([wearing("a"), { id: "b" }, layout])).toBeNull();
    expect(activeFrameLayout([{ id: "a" }, layout])).toBeNull();
    expect(activeFrameLayout([layout])).toBeNull();
    // A layout deleted since is no layout.
    expect(activeFrameLayout([wearing("a")])).toBeNull();
  });

  it("goes on a scene that joins, and on nothing else", () => {
    const joined = withActiveLayoutOnNewScenes(
      [wearing("a", { height: 40 }), layout],
      [{ id: "new" }, { id: "another-layout", settings: { isLayout: true } }, { id: "own", layout: { sceneId: "x" } }],
    );
    expect(joined[0]?.layout).toEqual({ sceneId: "bar", state: { height: 40 } });
    expect(joined[1]).not.toHaveProperty("layout");
    expect(joined[2]?.layout).toEqual({ sceneId: "x" });
  });

  it("leaves what joins alone on a frame with none active", () => {
    expect(withActiveLayoutOnNewScenes([{ id: "a" }, layout], [{ id: "new" }])).toEqual([{ id: "new" }]);
  });

  it("says what a list of scenes wears, for a cloud assignment row", () => {
    expect(layoutsWornBy([{ id: "a" }, { id: "b" }], [wearing("a"), { id: "b" }])).toEqual({ a: { sceneId: "bar" } });
  });
});

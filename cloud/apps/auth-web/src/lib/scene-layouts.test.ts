import { describe, expect, it } from "vitest";
import {
  maxLayoutStateBytes,
  readLayoutsField,
  readSceneLayout,
  sceneLayoutsOf,
  withSceneLayouts,
} from "./scene-layouts";

describe("readSceneLayout", () => {
  it("normalizes a layout and drops an empty state", () => {
    expect(readSceneLayout({ sceneId: " bar " })).toEqual({ sceneId: "bar" });
    expect(readSceneLayout({ sceneId: "bar", state: {} })).toEqual({ sceneId: "bar" });
    expect(readSceneLayout({ sceneId: "bar", state: { height: 40, colors: ["#fff"] } })).toEqual({
      sceneId: "bar",
      state: { colors: ["#fff"], height: 40 },
    });
  });

  it("refuses what is not one", () => {
    expect(readSceneLayout(null)).toBe(false);
    expect(readSceneLayout({})).toBe(false);
    expect(readSceneLayout({ sceneId: 3 })).toBe(false);
    expect(readSceneLayout({ sceneId: "bar", state: [] })).toBe(false);
    expect(readSceneLayout({ sceneId: "x".repeat(257) })).toBe(false);
    expect(readSceneLayout({ sceneId: "bar", state: { big: "x".repeat(maxLayoutStateBytes) } })).toBe(false);
  });
});

describe("readLayoutsField", () => {
  it("tells absent, cleared and malformed apart", () => {
    expect(readLayoutsField(undefined)).toBeUndefined();
    expect(readLayoutsField(null)).toBeNull();
    expect(readLayoutsField({})).toBeNull();
    expect(readLayoutsField([])).toBe(false);
    expect(readLayoutsField({ clock: { nope: 1 } })).toBe(false);
    expect(readLayoutsField({ clock: { sceneId: "bar" } })).toEqual({ clock: { sceneId: "bar" } });
  });

  it("tolerates whatever an older column holds", () => {
    expect(sceneLayoutsOf("junk")).toBeNull();
    expect(sceneLayoutsOf(null)).toBeNull();
    expect(sceneLayoutsOf({ clock: { sceneId: "bar" } })).toEqual({ clock: { sceneId: "bar" } });
  });
});

describe("withSceneLayouts", () => {
  const scenes = [
    { id: "clock", nodes: [] },
    { id: "photo", nodes: [], layout: { sceneId: "stale" } },
  ];

  it("writes each install's layout on and never lets a published one travel", () => {
    const stamped = withSceneLayouts(scenes, { clock: { sceneId: "bar", state: { height: 40 } } });
    expect(stamped[0]).toEqual({ id: "clock", nodes: [], layout: { sceneId: "bar", state: { height: 40 } } });
    expect(stamped[1]).not.toHaveProperty("layout");
    expect(withSceneLayouts(scenes, null)[1]).not.toHaveProperty("layout");
  });

  it("keeps the choice when a republish re-ided a pack's only scene", () => {
    const [only] = withSceneLayouts([{ id: "clock-v2", nodes: [] }], { clock: { sceneId: "bar" } });
    expect(only).toEqual({ id: "clock-v2", nodes: [], layout: { sceneId: "bar" } });
    expect(withSceneLayouts(scenes, { "clock-old": { sceneId: "bar" } })[0]).not.toHaveProperty("layout");
  });
});

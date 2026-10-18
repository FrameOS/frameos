// What the editor can say about how often a scene renders before a deploy: on
// a frame every scene inside a split renders when IT is due, so a split's
// panels each get a line like "every 10 min". A split's own interval is the
// fastest it renders, and it waits longer when no panel is due by then.
import { describe, expect, it } from "vitest";
import {
  describeRhythmSeconds,
  describeSceneRhythm,
  sceneFollowsChildren,
  sceneRhythm,
  splitPanelRhythm,
  splitSceneRhythmHint,
} from "../../../../../../frontend/src/utils/sceneRhythm";
import type { FrameScene } from "../../../../../../frontend/src/types";

const clock = {
  id: "clock",
  name: "Clock",
  nodes: [{ id: "r", type: "event", data: { keyword: "render" } }],
  edges: [],
  settings: { refreshInterval: 0.2 },
} as unknown as FrameScene;

// A scene that declares its own interval field (by role), and a panel that
// overrides it.
const photo = {
  id: "photo",
  name: "Photo",
  nodes: [{ id: "r", type: "event", data: { keyword: "render" } }],
  edges: [],
  fields: [{ name: "secondsBetweenImages", type: "float", value: "600", role: "refreshInterval" }],
  settings: { refreshInterval: 3600 },
} as unknown as FrameScene;

const split = {
  id: "split",
  name: "Split",
  nodes: [
    { id: "a", type: "scene", data: { keyword: "clock", config: {} } },
    { id: "b", type: "scene", data: { keyword: "photo", config: { secondsBetweenImages: 120 } } },
  ],
  edges: [],
  settings: { refreshInterval: 0.04, splitScreenLayout: { name: "Split" } },
} as unknown as FrameScene;

// The same split left on the frame's default interval.
const slowSplit = {
  ...split,
  id: "slow-split",
  settings: { refreshInterval: 300, splitScreenLayout: { name: "Split" } },
} as unknown as FrameScene;

describe("sceneRhythm", () => {
  it("reads a plain scene's refresh interval", () => {
    expect(sceneRhythm(clock)).toEqual({ seconds: 0.2, source: "interval" });
    // No setting at all: the interval field's own default, like every surface.
    expect(sceneRhythm({ ...clock, settings: {} } as FrameScene, {}, [], 900)).toEqual({
      seconds: 300,
      source: "interval",
    });
  });

  it("reads a declared interval field, from its default or the panel's override", () => {
    expect(sceneRhythm(photo)).toEqual({ seconds: 600, source: "interval" });
    expect(sceneRhythm(photo, { secondsBetweenImages: "90" })).toEqual({ seconds: 90, source: "interval" });
    // The implicit field every other scene has works the same way.
    expect(sceneRhythm(clock, { refreshInterval: 5 })).toEqual({ seconds: 5, source: "interval" });
  });

  it("lets a split wait for its first panel, never renders it faster than its own interval", () => {
    expect(sceneFollowsChildren(split)).toBe(true);
    expect(sceneFollowsChildren(photo)).toBe(false);
    expect(sceneRhythm(split, {}, [clock, photo, split])).toEqual({ seconds: 0.2, source: "children" });
    expect(sceneRhythm(split, {}, [photo, split])).toEqual({ seconds: 120, source: "children" });
    // A split whose panels are all missing keeps its own interval.
    expect(sceneRhythm(split, {}, [split])).toEqual({ seconds: 0.04, source: "interval" });
    // On 300 s, a 0.2 s clock does not make it render faster.
    expect(sceneRhythm(slowSplit, {}, [clock, photo])).toEqual({ seconds: 300, source: "interval" });
  });

  it("describes it the way a person would", () => {
    expect(describeRhythmSeconds(0.2)).toBe("5 times a second");
    expect(describeRhythmSeconds(0.75)).toBe("every 0.75 s");
    expect(describeRhythmSeconds(30)).toBe("every 30 s");
    expect(describeRhythmSeconds(600)).toBe("every 10 min");
    expect(describeRhythmSeconds(5400)).toBe("every 1.5 h");
    expect(describeRhythmSeconds(86400)).toBe("every day");
    expect(describeSceneRhythm({ seconds: 60, source: "children" })).toBe("every 1 min (its fastest panel)");
  });

  it("describes a split panel from its options and the split's interval", () => {
    expect(splitPanelRhythm(photo, { secondsBetweenImages: 1800 }, [photo], 300, 300)).toBe("every 30 min");
    expect(splitPanelRhythm(clock, {}, [clock], 300, 300)).toBe("every 5 min (the split's interval)");
    expect(splitPanelRhythm(null, {}, [photo], 300, 300)).toBeNull();
  });

  it("explains a split's interval, and nothing else's", () => {
    expect(splitSceneRhythmHint(split, [clock, photo, split], 300)).toBe(
      "Each panel renders on its own schedule, at most this often. With these panels: 5 times a second (its fastest panel)."
    );
    expect(splitSceneRhythmHint(photo, [photo], 300)).toBeNull();
    expect(splitSceneRhythmHint(null, [], 300)).toBeNull();
  });
});

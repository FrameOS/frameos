// What the editor can say about how often a scene renders before a deploy: on
// a frame every scene inside a split renders when IT is due, so a split's
// panels each get a line like "every 10 min". A split renders when its first
// panel is due; on e-paper or deep sleep its own interval is also the fastest
// it renders (framePacedByInterval).
import { describe, expect, it } from "vitest";
import {
  describeRhythmSeconds,
  describeSceneRhythm,
  framePacedByInterval,
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

  it("renders a split when its first panel is due on a real-time display", () => {
    expect(sceneFollowsChildren(split)).toBe(true);
    expect(sceneFollowsChildren(photo)).toBe(false);
    expect(sceneRhythm(split, {}, [clock, photo, split])).toEqual({ seconds: 0.2, source: "children" });
    expect(sceneRhythm(split, {}, [photo, split])).toEqual({ seconds: 120, source: "children" });
    // A split whose panels are all missing keeps its own interval.
    expect(sceneRhythm(split, {}, [split])).toEqual({ seconds: 0.04, source: "interval" });
    // Left on 300 s, a 0.2 s clock still sets the pace: nothing holds it back.
    expect(sceneRhythm(slowSplit, {}, [clock, photo])).toEqual({ seconds: 0.2, source: "children" });
  });

  it("keeps a split's own interval as the floor where a render is a refresh or a wake", () => {
    expect(sceneRhythm(slowSplit, {}, [clock, photo], 300, true)).toEqual({ seconds: 300, source: "interval" });
    expect(sceneRhythm(split, {}, [photo, split], 300, true)).toEqual({ seconds: 120, source: "children" });
  });

  it("lets a layout's panels wake the scene wearing it, on a real-time display only", () => {
    const bar = { ...clock, id: "bar", settings: { refreshInterval: 1, isLayout: true } } as unknown as FrameScene;
    const wearing = { ...photo, layout: { sceneId: "bar" } } as unknown as FrameScene;
    expect(sceneRhythm(wearing, {}, [wearing, bar])).toEqual({ seconds: 1, source: "children" });
    expect(sceneRhythm(wearing, {}, [wearing, bar], 300, true)).toEqual({ seconds: 600, source: "interval" });
    // A layout no longer on the frame paces nothing.
    expect(sceneRhythm(wearing, {}, [wearing])).toEqual({ seconds: 600, source: "interval" });
  });

  it("knows which frames are held back by their interval", () => {
    const device = (name: string, extra = {}) => ({ device: name, ...extra }) as never;
    expect(framePacedByInterval(device("framebuffer"))).toBe(false);
    expect(framePacedByInterval(device("waveshare.EPD_7in5_V2"))).toBe(true);
    expect(framePacedByInterval(device("pimoroni.inky_impression_7"))).toBe(true);
    expect(framePacedByInterval(device("embedded", { hardware: { pixelFormat: 9 } }))).toBe(false);
    expect(framePacedByInterval(device("embedded", { hardware: { pixelFormat: 6 } }))).toBe(true);
    expect(framePacedByInterval(device("embedded", { hardware: { pixelFormat: 9 }, deep_sleep: true }))).toBe(true);
    expect(framePacedByInterval(null)).toBe(false);
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
    expect(splitPanelRhythm(clock, {}, [clock], 300, 300)).toBe("5 times a second");
    expect(splitPanelRhythm(clock, {}, [clock], 300, 300, true)).toBe("every 5 min (the split's interval)");
    expect(splitPanelRhythm(null, {}, [photo], 300, 300)).toBeNull();
  });

  it("explains a split's interval, and nothing else's", () => {
    expect(splitSceneRhythmHint(split, [clock, photo, split], 300)).toBe(
      "Each panel renders on its own schedule, and the frame wakes when the first one is due. With these panels: 5 times a second (its fastest panel)."
    );
    expect(splitSceneRhythmHint(slowSplit, [clock, photo], 300, true)).toBe(
      "Each panel renders on its own schedule, at most this often. With these panels: every 5 min."
    );
    expect(splitSceneRhythmHint(photo, [photo], 300)).toBeNull();
    expect(splitSceneRhythmHint(null, [], 300)).toBeNull();
  });
});

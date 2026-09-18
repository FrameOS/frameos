// What the editor can say about a scene's rhythm before a deploy: on a frame
// every embedded scene renders when IT is due, so a split's panels each get a
// line like "every 10 min", and the split itself shows "auto".
import { describe, expect, it } from "vitest";
import {
  describeRhythmSeconds,
  describeSceneRhythm,
  sceneFollowsChildren,
  sceneRhythm,
} from "../../../../../../frontend/src/utils/sceneRhythm";
import type { FrameScene } from "../../../../../../frontend/src/types";

const clock = {
  id: "clock",
  name: "Clock",
  nodes: [{ id: "r", type: "event", data: { keyword: "render" } }],
  edges: [],
  settings: { refreshInterval: 0.2 },
} as unknown as FrameScene;

// The stock photo scenes: render → … → logic/nextSleepDuration ← state field.
const photo = {
  id: "photo",
  name: "Photo",
  nodes: [
    { id: "r", type: "event", data: { keyword: "render" } },
    { id: "sleep", type: "app", data: { keyword: "logic/nextSleepDuration", config: {} } },
    { id: "seconds", type: "state", data: { keyword: "secondsBetweenImages" } },
  ],
  edges: [{ id: "e", source: "seconds", sourceHandle: "stateOutput", target: "sleep", targetHandle: "fieldInput/duration" }],
  fields: [{ name: "secondsBetweenImages", type: "float", value: "600" }],
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
  settings: { refreshInterval: 300, splitScreenLayout: { name: "Split" } },
} as unknown as FrameScene;

describe("sceneRhythm", () => {
  it("reads a plain scene's refresh interval", () => {
    expect(sceneRhythm(clock)).toEqual({ seconds: 0.2, source: "interval" });
    expect(sceneRhythm({ ...clock, settings: {} } as FrameScene, {}, [], 900)).toEqual({
      seconds: 900,
      source: "interval",
    });
  });

  it("prefers the scene's own nextSleepDuration, from the field default or the panel's override", () => {
    expect(sceneRhythm(photo)).toEqual({ seconds: 600, source: "nextSleep" });
    expect(sceneRhythm(photo, { secondsBetweenImages: "90" })).toEqual({ seconds: 90, source: "nextSleep" });
  });

  it("gives a split the rhythm of its fastest panel, not its own interval", () => {
    expect(sceneFollowsChildren(split)).toBe(true);
    expect(sceneFollowsChildren(photo)).toBe(false);
    expect(sceneRhythm(split, {}, [clock, photo, split])).toEqual({ seconds: 0.2, source: "children" });
    expect(sceneRhythm(split, {}, [photo, split])).toEqual({ seconds: 120, source: "children" });
  });

  it("describes it the way a person would", () => {
    expect(describeRhythmSeconds(0.2)).toBe("5× a second");
    expect(describeRhythmSeconds(0.75)).toBe("every 0.75 s");
    expect(describeRhythmSeconds(30)).toBe("every 30 s");
    expect(describeRhythmSeconds(600)).toBe("every 10 min");
    expect(describeRhythmSeconds(5400)).toBe("every 1.5 h");
    expect(describeRhythmSeconds(86400)).toBe("every day");
    expect(describeSceneRhythm({ seconds: null, source: "runtime" })).toBe("paces itself");
    expect(describeSceneRhythm({ seconds: 60, source: "children" })).toBe("every 1 min (its fastest panel)");
  });
});

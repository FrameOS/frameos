import { describe, expect, it } from "vitest";
import {
  readEventMapRule,
  readEventMapsField,
  withSceneEventMaps,
} from "./scene-event-map";

const refreshIsA = {
  event: "button",
  match: { label: "REFRESH", action: "press" },
  as: { label: "A", role: "primary" },
};

describe("readEventMapsField", () => {
  it("is undefined when absent, null when cleared, and the maps when well-formed", () => {
    expect(readEventMapsField(undefined)).toBeUndefined();
    expect(readEventMapsField(null)).toBeNull();
    expect(readEventMapsField({})).toBeNull();
    expect(readEventMapsField({ clock: [] })).toBeNull();
    expect(readEventMapsField({ clock: [refreshIsA] })).toEqual({ clock: [refreshIsA] });
  });

  it("normalizes a rule: trimmed event name, no empty match, values as given", () => {
    expect(readEventMapRule({ event: " button ", as: { label: "A", pin: 17, wake: true } })).toEqual({
      event: "button",
      as: { label: "A", pin: 17, wake: true },
    });
    expect(readEventMapRule({ event: "button", match: {}, as: { label: "A" } })).toEqual({
      event: "button",
      as: { label: "A" },
    });
  });

  it("refuses what is not a map", () => {
    for (const bad of [
      [],
      "button",
      { clock: "not a list" },
      { clock: [{ as: { label: "A" } }] },
      { clock: [{ event: "button" }] },
      { clock: [{ event: "button", as: "A" }] },
      { clock: [{ event: "button", as: { label: ["A"] } }] },
      { clock: [{ event: "button", match: "REFRESH", as: { label: "A" } }] },
      { clock: [{ event: "button", as: { "bad key": "A" } }] },
      { clock: [{ event: "x".repeat(64), as: { label: "A" } }] },
      { clock: Array.from({ length: 65 }, () => refreshIsA) },
    ]) {
      expect(readEventMapsField(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("withSceneEventMaps", () => {
  const scenes = [
    { id: "clock", name: "Clock", nodes: [] },
    { id: "weather", name: "Weather", nodes: [], eventMap: [{ event: "button", as: { label: "Z" } }] },
  ];

  it("writes each scene's rules on by runtime id and drops a map inside the published content", () => {
    const stamped = withSceneEventMaps(scenes, { clock: [refreshIsA] });
    expect(stamped[0]).toEqual({ ...scenes[0], eventMap: [refreshIsA] });
    // The published bytes never carry an install's map: a stale one is gone.
    expect(stamped[1]).toEqual({ id: "weather", name: "Weather", nodes: [] });
    expect(withSceneEventMaps(scenes, null)[1]).not.toHaveProperty("eventMap");
  });

  it("gives a lone scene the lone list whatever id it has now", () => {
    const [only] = withSceneEventMaps([{ id: "clock-v2", nodes: [] }], { clock: [refreshIsA] });
    expect(only).toEqual({ id: "clock-v2", nodes: [], eventMap: [refreshIsA] });
    // ...but not when either side is ambiguous.
    const two = withSceneEventMaps(scenes, { "clock-old": [refreshIsA] });
    expect(two.some((scene) => "eventMap" in scene)).toBe(false);
  });
});

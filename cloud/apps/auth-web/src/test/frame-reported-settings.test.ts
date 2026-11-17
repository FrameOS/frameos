import { describe, expect, it } from "vitest";
import { settingsWithReported } from "../lib/frames";

describe("settingsWithReported", () => {
  it("takes the frame's rotation and scale, keeping the rest", () => {
    expect(settingsWithReported({ interval: 60 }, { rotate: 90 })).toEqual({ interval: 60, rotate: 90 });
    expect(settingsWithReported({ rotate: 0 }, { rotate: 270, renderScale: 1.5 })).toEqual({
      rotate: 270,
      render_scale: 1.5,
    });
    expect(settingsWithReported(null, { rotate: 180 })).toEqual({ rotate: 180 });
    expect(settingsWithReported({ render_scale: 2 }, { renderScale: 0 })).toEqual({ render_scale: 0 });
  });

  it("has nothing to change when they agree, or a key never set is the default", () => {
    expect(settingsWithReported({ rotate: 90, render_scale: 2 }, { rotate: 90, renderScale: 2 })).toBeUndefined();
    expect(settingsWithReported({}, { rotate: 0, renderScale: 0 })).toBeUndefined();
  });

  it("takes the event map set on the frame's page, by value, into a mirror that holds one", () => {
    const left = { event: "button", match: { label: "LEFT", action: "longPress" }, emit: "sceneSwitcher", as: {} };
    const top = { event: "edgeSwipe", match: { edge: "top" }, emit: "sceneSettings", as: {} };
    expect(settingsWithReported({ event_map: [top] }, { eventMap: [left, top] })).toEqual({ event_map: [left, top] });
    expect(settingsWithReported({ event_map: [top] }, { eventMap: [] })).toEqual({ event_map: [] });
    // The same rules, their keys in another order, change nothing.
    expect(
      settingsWithReported(
        { event_map: [{ as: {}, emit: "sceneSettings", match: { edge: "top" }, event: "edgeSwipe" }] },
        { eventMap: [top] },
      ),
    ).toBeUndefined();
    // A mirror that never held one shows the reported map already: the board's
    // own stays the board's.
    expect(settingsWithReported({ rotate: 0 }, { eventMap: [left] })).toBeUndefined();
  });

  it("ignores a report without them, as older firmware's, and nonsense", () => {
    expect(settingsWithReported({ rotate: 90 }, { platform: "esp32" })).toBeUndefined();
    expect(settingsWithReported({ rotate: 90 }, { rotate: 45 })).toBeUndefined();
    expect(settingsWithReported({ rotate: 90 }, { rotate: "90" })).toBeUndefined();
    expect(settingsWithReported({ render_scale: 1 }, { renderScale: 9 })).toBeUndefined();
    expect(settingsWithReported({ rotate: 90 }, null)).toBeUndefined();
  });
});

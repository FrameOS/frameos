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

  it("ignores a report without them, as older firmware's, and nonsense", () => {
    expect(settingsWithReported({ rotate: 90 }, { platform: "esp32" })).toBeUndefined();
    expect(settingsWithReported({ rotate: 90 }, { rotate: 45 })).toBeUndefined();
    expect(settingsWithReported({ rotate: 90 }, { rotate: "90" })).toBeUndefined();
    expect(settingsWithReported({ render_scale: 1 }, { renderScale: 9 })).toBeUndefined();
    expect(settingsWithReported({ rotate: 90 }, null)).toBeUndefined();
  });
});

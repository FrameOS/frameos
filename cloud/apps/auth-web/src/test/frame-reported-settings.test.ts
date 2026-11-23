import { describe, expect, it } from "vitest";
import { settingsWithReported } from "../lib/frames";

describe("settingsWithReported", () => {
  it("takes the frame's rotation and scale, keeping the rest", () => {
    expect(settingsWithReported({ scaling_mode: "cover" }, { rotate: 90 })).toEqual({ scaling_mode: "cover", rotate: 90 });
    // A stored `interval` (from before frames lost theirs) is not carried on.
    expect(settingsWithReported({ interval: 60 }, { rotate: 90 })).toEqual({ rotate: 90 });
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

  it("takes the tap and click sounds set on the frame page; normal is the default", () => {
    expect(settingsWithReported({ rotate: 90 }, { clickSounds: "silent" })).toEqual({ rotate: 90, click_sounds: "silent" });
    expect(settingsWithReported({ click_sounds: "silent" }, { clickSounds: "normal" })).toEqual({ click_sounds: "normal" });
    expect(settingsWithReported({}, { clickSounds: "normal" })).toBeUndefined();
    expect(settingsWithReported({}, { clickSounds: "loud" })).toBeUndefined();
  });

  it("takes how long a tap keeps the frame up, set on the frame page; 300 s is the default", () => {
    expect(settingsWithReported({ rotate: 90 }, { awakeAfterInputSeconds: 60 })).toEqual({
      rotate: 90,
      awake_after_input_seconds: 60,
    });
    expect(settingsWithReported({ awake_after_input_seconds: 60 }, { awakeAfterInputSeconds: 0 })).toEqual({
      awake_after_input_seconds: 0,
    });
    expect(settingsWithReported({}, { awakeAfterInputSeconds: 300 })).toBeUndefined();
    expect(settingsWithReported({}, { awakeAfterInputSeconds: 3601 })).toBeUndefined();
    expect(settingsWithReported({}, { awakeAfterInputSeconds: 1.5 })).toBeUndefined();
  });

  it("ignores a report without them, as older firmware's, and nonsense", () => {
    expect(settingsWithReported({ rotate: 90 }, { platform: "esp32" })).toBeUndefined();
    expect(settingsWithReported({ rotate: 90 }, { rotate: 45 })).toBeUndefined();
    expect(settingsWithReported({ rotate: 90 }, { rotate: "90" })).toBeUndefined();
    expect(settingsWithReported({ render_scale: 1 }, { renderScale: 9 })).toBeUndefined();
    expect(settingsWithReported({ rotate: 90 }, null)).toBeUndefined();
  });
});

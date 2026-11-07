import { describe, expect, it } from "vitest";
import { settingsWithReportedRotate } from "../lib/frames";

describe("settingsWithReportedRotate", () => {
  it("takes the frame's rotation, keeping the rest", () => {
    expect(settingsWithReportedRotate({ interval: 60 }, { rotate: 90 })).toEqual({ interval: 60, rotate: 90 });
    expect(settingsWithReportedRotate({ rotate: 0 }, { rotate: 270 })).toEqual({ rotate: 270 });
    expect(settingsWithReportedRotate(null, { rotate: 180 })).toEqual({ rotate: 180 });
  });

  it("has nothing to change when they agree", () => {
    expect(settingsWithReportedRotate({ rotate: 90 }, { rotate: 90 })).toBeUndefined();
  });

  it("ignores a report without one, as a Pi's and older firmware's, and nonsense", () => {
    expect(settingsWithReportedRotate({ rotate: 90 }, { platform: "esp32" })).toBeUndefined();
    expect(settingsWithReportedRotate({ rotate: 90 }, { rotate: 45 })).toBeUndefined();
    expect(settingsWithReportedRotate({ rotate: 90 }, { rotate: "90" })).toBeUndefined();
    expect(settingsWithReportedRotate({ rotate: 90 }, null)).toBeUndefined();
  });
});

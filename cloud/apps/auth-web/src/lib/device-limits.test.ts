// The device presets the preview simulates (frameos-wasm/src/devices.ts).
// The ESP32 numbers mirror the firmware/backend constants; these tests pin
// the budget math so a drive-by edit cannot quietly hand the simulated board
// more (or less) memory than the real one has.
import { describe, expect, it } from "vitest";
import {
  describeDeviceLimits,
  deviceLimitsFor,
  devicePresetFor,
  devicePresets,
  esp32RenderBudgetBytes,
} from "frameos-wasm";

describe("deviceLimitsFor", () => {
  it("simulates nothing for the browser preset and unknown keys", () => {
    expect(deviceLimitsFor("browser", 800, 480)).toBeNull();
    expect(deviceLimitsFor(null, 800, 480)).toBeNull();
    expect(deviceLimitsFor("no-such-device", 800, 480)).toBeNull();
    expect(devicePresetFor("browser")).toBeNull();
    expect(devicePresetFor("esp32")?.label).toContain("ESP32");
  });

  it("gives the ESP32 the firmware's ceilings", () => {
    const limits = deviceLimitsFor("esp32", 800, 480)!;
    expect(limits.jsMemoryLimitMb).toBe(4); // FOS_JS_MEMORY_LIMIT
    expect(limits.jsMaxStackKb).toBe(20); // FOS_JS_STACK_SIZE
    expect(limits.maxHttpResponseBytes).toBe(6 * 1024 * 1024); // the spill cap
  });

  it("keeps the Pi presets on default JS/HTTP limits with a capped render budget", () => {
    const pi = deviceLimitsFor("pi", 800, 480)!;
    expect(pi.availableRenderBytes).toBe(512 * 1024 * 1024);
    expect(pi.jsMemoryLimitMb).toBe(-1);
    const zero = deviceLimitsFor("piZero", 800, 480)!;
    expect(zero.availableRenderBytes).toBe(256 * 1024 * 1024);
    expect(zero.maxHttpResponseBytes).toBe(0);
  });

  it("lists every preset the picker offers", () => {
    for (const preset of devicePresets) {
      if (preset.key === "browser") {
        expect(deviceLimitsFor(preset.key, 800, 480)).toBeNull();
      } else {
        expect(deviceLimitsFor(preset.key, 800, 480)).not.toBeNull();
      }
    }
  });
});

describe("esp32RenderBudgetBytes", () => {
  it("lands near the 4 MB the ESP32 test corpus pins at 800×480", () => {
    const budget = esp32RenderBudgetBytes(800, 480);
    expect(budget).toBeGreaterThan(3 * 1024 * 1024);
    expect(budget).toBeLessThan(5 * 1024 * 1024);
  });

  it("flips to an RGB565 canvas on the 13.3\" panel and leaves under 1 MB", () => {
    // 1200×1600 RGBX would need the whole 8 MB twice over; the firmware
    // falls back to 2 bytes/pixel and the board really is this tight.
    const budget = esp32RenderBudgetBytes(1200, 1600);
    expect(budget).toBeGreaterThanOrEqual(512 * 1024);
    expect(budget).toBeLessThan(1024 * 1024);
  });

  it("a bigger canvas always leaves the same or less to render with (per format)", () => {
    expect(esp32RenderBudgetBytes(960, 640)).toBeLessThan(esp32RenderBudgetBytes(800, 480));
  });
});

describe("describeDeviceLimits", () => {
  it("names every ceiling in effect and skips the defaults", () => {
    const esp32 = describeDeviceLimits(deviceLimitsFor("esp32", 800, 480)!);
    expect(esp32).toContain("MB render memory");
    expect(esp32).toContain("4 MB JS heap");
    expect(esp32).toContain("20 KB JS stack");
    expect(esp32).toContain("6 MB max HTTP response");
    const pi = describeDeviceLimits(deviceLimitsFor("pi", 800, 480)!);
    expect(pi).toBe("about 512 MB render memory");
  });
});

import { describe, expect, it } from "vitest";
import {
  describeDeviceLimits,
  deviceLimitsFor,
  devicePresetFor,
  devicePresets,
  esp32CanvasBytesPerPixel,
  esp32DeviceHeapBytes,
  esp32PreviewMemoryBytes,
} from "frameos-wasm";

// The preview's ESP32 preset has to keep step with the firmware, or the
// simulation stops predicting anything. These pin it to the constants it was
// derived from — 8 MB of PSRAM, the packed 4 bpp panel buffer the display
// driver owns, and the 1 MB emergency reserve armed at boot.
const PSRAM = 8 * 1024 * 1024;
const EMERGENCY_RESERVE = 1024 * 1024;

describe("device presets", () => {
  it("offers browser plus the three frame classes", () => {
    expect(devicePresets.map((preset) => preset.key)).toEqual([
      "browser",
      "pi",
      "piZero",
      "esp32",
    ]);
  });

  it("treats browser and unknown keys as no simulation", () => {
    expect(devicePresetFor("browser")).toBeNull();
    expect(devicePresetFor(null)).toBeNull();
    expect(devicePresetFor("nonsense")).toBeNull();
    expect(deviceLimitsFor("browser", 800, 480)).toBeNull();
    expect(deviceLimitsFor(undefined, 800, 480)).toBeNull();
  });
});

describe("the ESP32 canvas format", () => {
  it("stays RGBX while the canvas fits twice into PSRAM", () => {
    // 800x480 RGBX is 1.5 MB; two of those fit 8 MB easily.
    expect(esp32CanvasBytesPerPixel(800, 480)).toBe(4);
  });

  it("falls back to RGB565 on the 13.3 inch panels", () => {
    // 1200x1600 RGBX is 7.68 MB — two would not fit, so the firmware halves it.
    expect(esp32CanvasBytesPerPixel(1200, 1600)).toBe(2);
  });
});

describe("the ESP32 memory ceiling", () => {
  it("is PSRAM less the panel buffer and the emergency reserve", () => {
    const packed = Math.ceil((1200 * 1600) / 2);
    expect(esp32DeviceHeapBytes(1200, 1600)).toBe(
      PSRAM - packed - EMERGENCY_RESERVE,
    );
    // 6.38 MB, of which the 3.84 MB RGB565 canvas is one part: the ~2.5 MB
    // left is what a 13.3" frame really renders in.
    expect(esp32DeviceHeapBytes(1200, 1600) - 1200 * 1600 * 2).toBeGreaterThan(
      2.4 * 1024 * 1024,
    );
    expect(esp32DeviceHeapBytes(1200, 1600) - 1200 * 1600 * 2).toBeLessThan(
      2.6 * 1024 * 1024,
    );
  });

  it("converts the canvas to the format the preview keeps it in", () => {
    // The device holds a 13.3" canvas in RGB565 and the preview holds it in
    // RGBX, so the preview needs that one term doubled to have the same room
    // left for everything else.
    const pixels = 1200 * 1600;
    expect(esp32PreviewMemoryBytes(1200, 1600)).toBe(
      esp32DeviceHeapBytes(1200, 1600) - pixels * 2 + pixels * 4,
    );
    // Nothing to convert where the device is already RGBX.
    expect(esp32PreviewMemoryBytes(800, 480)).toBe(
      esp32DeviceHeapBytes(800, 480),
    );
  });

  it("leaves a 13.3 inch frame less room than a 7.3 inch one", () => {
    const big = esp32PreviewMemoryBytes(1200, 1600) - 1200 * 1600 * 4;
    const small = esp32PreviewMemoryBytes(800, 480) - 800 * 480 * 4;
    expect(big).toBeLessThan(small);
  });
});

describe("deviceLimitsFor", () => {
  it("carries the firmware's JS and HTTP ceilings for an ESP32", () => {
    const limits = deviceLimitsFor("esp32", 1200, 1600);
    expect(limits).not.toBeNull();
    expect(limits!.memoryBytes).toBe(esp32PreviewMemoryBytes(1200, 1600));
    expect(limits!.jsMemoryLimitMb).toBe(4);
    expect(limits!.jsMaxStackKb).toBe(20);
    expect(limits!.maxHttpResponseBytes).toBe(6 * 1024 * 1024);
    // Deliberately unsimulated — see the comment on the preset.
    expect(limits!.memoryReserveBytes).toBe(0);
  });

  it("gives the Pi presets room and the host's JS defaults", () => {
    for (const key of ["pi", "piZero"]) {
      const limits = deviceLimitsFor(key, 800, 480)!;
      expect(limits.memoryBytes).toBeGreaterThan(200 * 1024 * 1024);
      expect(limits.jsMemoryLimitMb).toBe(-1);
      expect(limits.jsMaxStackKb).toBe(-1);
      expect(limits.maxHttpResponseBytes).toBe(0);
    }
    expect(deviceLimitsFor("piZero", 800, 480)!.memoryBytes).toBeLessThan(
      deviceLimitsFor("pi", 800, 480)!.memoryBytes,
    );
  });

  it("describes the ceilings in one line", () => {
    const text = describeDeviceLimits(deviceLimitsFor("esp32", 1200, 1600)!);
    expect(text).toContain("MB of render memory");
    expect(text).toContain("4 MB JS heap");
    expect(text).toContain("20 KB JS stack");
    expect(text).toContain("6 MB max HTTP response");
  });
});

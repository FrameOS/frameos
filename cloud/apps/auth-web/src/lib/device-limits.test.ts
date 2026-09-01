import { describe, expect, it } from "vitest";
import {
  describeDeviceLimits,
  deviceLimitsFor,
  devicePresetFor,
  devicePresets,
  esp32CanvasBytesPerPixel,
  esp32DeviceHeapBytes,
  esp32PreviewMemoryBytes,
  esp32PreviewOverheadBytes,
  piDeviceHeapBytes,
} from "frameos-wasm";

// The presets have to keep step with the firmware and with what real frames
// report, or the simulation stops predicting anything. These pin them to the
// constants and measurements they were derived from.
const PSRAM_8MB = 8 * 1024 * 1024;
const PSRAM_16MB = 16 * 1024 * 1024;
const EMERGENCY_RESERVE = 1024 * 1024;
const MB = 1024 * 1024;

describe("device presets", () => {
  it("offers the four frame classes and no off entry", () => {
    // "Off" is the checkbox in front of the picker, not a row in it.
    expect(devicePresets.map((preset) => preset.key)).toEqual([
      "pi",
      "piZero",
      "esp32_16mb",
      "esp32",
    ]);
  });

  it("treats no key and unknown keys as no simulation", () => {
    expect(devicePresetFor(null)).toBeNull();
    expect(devicePresetFor("")).toBeNull();
    expect(devicePresetFor("nonsense")).toBeNull();
    expect(deviceLimitsFor(null, 800, 480)).toBeNull();
    expect(deviceLimitsFor(undefined, 800, 480)).toBeNull();
    expect(deviceLimitsFor("browser", 800, 480)).toBeNull();
  });
});

describe("the ESP32 canvas format", () => {
  it("stays RGBX while two canvases fit the PSRAM heap", () => {
    // 800x480 RGBX is 1.5 MB; two of those fit 8 MB easily.
    expect(esp32CanvasBytesPerPixel(800, 480, PSRAM_8MB)).toBe(4);
    // 1200x1600 RGBX is 7.68 MB — two fit 16 MB, and a live 16 MB frame
    // confirms it: 6,537 KB free PSRAM mid-scene is exactly 16 MB less an
    // RGBX canvas, the packed panel buffer and the emergency reserve.
    expect(esp32CanvasBytesPerPixel(1200, 1600, PSRAM_16MB)).toBe(4);
  });

  it("falls back to RGB565 on a 13.3 inch panel with only 8 MB", () => {
    expect(esp32CanvasBytesPerPixel(1200, 1600, PSRAM_8MB)).toBe(2);
  });

  it("defaults to the 8 MB board", () => {
    expect(esp32CanvasBytesPerPixel(1200, 1600)).toBe(
      esp32CanvasBytesPerPixel(1200, 1600, PSRAM_8MB),
    );
  });
});

describe("the ESP32 memory ceiling", () => {
  it("is PSRAM less the panel buffer and the emergency reserve", () => {
    const packed = Math.ceil((1200 * 1600) / 2);
    expect(esp32DeviceHeapBytes(1200, 1600, PSRAM_8MB)).toBe(
      PSRAM_8MB - packed - EMERGENCY_RESERVE,
    );
    expect(esp32DeviceHeapBytes(1200, 1600, PSRAM_16MB)).toBe(
      PSRAM_16MB - packed - EMERGENCY_RESERVE,
    );
  });

  it("leaves a 13.3 inch 8 MB frame about 2.5 MB above its canvas", () => {
    // What the E1004 really renders in — the board this whole simulation
    // exists because of.
    const aboveCanvas =
      esp32DeviceHeapBytes(1200, 1600, PSRAM_8MB) - 1200 * 1600 * 2;
    expect(aboveCanvas).toBeGreaterThan(2.4 * MB);
    expect(aboveCanvas).toBeLessThan(2.6 * MB);
  });

  it("leaves a 16 MB frame far more room than an 8 MB one", () => {
    const big =
      esp32DeviceHeapBytes(1200, 1600, PSRAM_16MB) - 1200 * 1600 * 4;
    const small =
      esp32DeviceHeapBytes(1200, 1600, PSRAM_8MB) - 1200 * 1600 * 2;
    expect(big).toBeGreaterThan(6 * MB);
    expect(big).toBeGreaterThan(small);
  });

  it("adds the preview's extra canvas cost, and only where the formats differ", () => {
    const pixels = 1200 * 1600;
    // 8 MB, RGB565 on the device and RGBX here: one canvas of difference.
    expect(esp32PreviewOverheadBytes(1200, 1600, PSRAM_8MB)).toBe(pixels * 2);
    expect(esp32PreviewMemoryBytes(1200, 1600, PSRAM_8MB)).toBe(
      esp32DeviceHeapBytes(1200, 1600, PSRAM_8MB) + pixels * 2,
    );
    // 16 MB, RGBX on both sides: nothing to convert.
    expect(esp32PreviewOverheadBytes(1200, 1600, PSRAM_16MB)).toBe(0);
    expect(esp32PreviewMemoryBytes(1200, 1600, PSRAM_16MB)).toBe(
      esp32DeviceHeapBytes(1200, 1600, PSRAM_16MB),
    );
    // Small panel, RGBX on both sides.
    expect(esp32PreviewOverheadBytes(800, 480, PSRAM_8MB)).toBe(0);
  });
});

describe("the Raspberry Pi ceiling", () => {
  it("takes the GPU split and the resting system off the board's RAM", () => {
    // Measured on a Pi Zero 2 W frame: memoryUsage.total 471,011,328 of a
    // nominal 512 MB (a ~63 MB GPU split), 99,434,496 used at idle.
    expect(piDeviceHeapBytes(512 * MB)).toBe(512 * MB - 64 * MB - 100 * MB);
    expect(piDeviceHeapBytes(1024 * MB)).toBe(1024 * MB - 64 * MB - 100 * MB);
  });

  it("lands near what the real frame reports free", () => {
    const zero = piDeviceHeapBytes(512 * MB);
    // The frame's own numbers put ~354 MB available at idle; the model says
    // 348 MB. Close enough to trust, far enough from the label that the
    // readout says "usable" rather than "512 MB".
    expect(zero).toBeGreaterThan(340 * MB);
    expect(zero).toBeLessThan(360 * MB);
  });

  it("never goes to zero on a hypothetically tiny board", () => {
    expect(piDeviceHeapBytes(64 * MB)).toBeGreaterThan(0);
  });
});

describe("deviceLimitsFor", () => {
  it("carries the firmware's JS and HTTP ceilings for both ESP32 boards", () => {
    for (const [key, psram] of [
      ["esp32", PSRAM_8MB],
      ["esp32_16mb", PSRAM_16MB],
    ] as const) {
      const limits = deviceLimitsFor(key, 1200, 1600)!;
      expect(limits.memoryBytes).toBe(
        esp32PreviewMemoryBytes(1200, 1600, psram),
      );
      expect(limits.previewOverheadBytes).toBe(
        esp32PreviewOverheadBytes(1200, 1600, psram),
      );
      expect(limits.jsMemoryLimitMb).toBe(4);
      expect(limits.jsMaxStackKb).toBe(20);
      expect(limits.maxHttpResponseBytes).toBe(6 * MB);
      // Deliberately unsimulated — see the comment on the preset.
      expect(limits.memoryReserveBytes).toBe(0);
    }
  });

  it("gives the Pi presets their measured room and the host's JS defaults", () => {
    for (const [key, nominal] of [
      ["pi", 1024 * MB],
      ["piZero", 512 * MB],
    ] as const) {
      const limits = deviceLimitsFor(key, 800, 480)!;
      expect(limits.memoryBytes).toBe(piDeviceHeapBytes(nominal));
      // A Pi has no canvas-format difference to correct for.
      expect(limits.previewOverheadBytes).toBe(0);
      // LinuxReserveBytes: the pipeline plans below it, allocation may use it.
      expect(limits.memoryReserveBytes).toBe(48 * MB);
      expect(limits.jsMemoryLimitMb).toBe(-1);
      expect(limits.jsMaxStackKb).toBe(-1);
      expect(limits.maxHttpResponseBytes).toBe(0);
    }
    expect(deviceLimitsFor("piZero", 800, 480)!.memoryBytes).toBeLessThan(
      deviceLimitsFor("pi", 800, 480)!.memoryBytes,
    );
  });

  it("describes the ceilings in the device's own bytes", () => {
    // 8 MB at 1200x1600: 6.1 MB on the device, not the 9.8 MB the preview
    // ceiling has to be to leave the same room.
    const text = describeDeviceLimits(deviceLimitsFor("esp32", 1200, 1600)!);
    expect(text).toContain("6.1 MB of render memory");
    expect(text).toContain("4 MB JS heap");
    expect(text).toContain("20 KB JS stack");
    expect(text).toContain("6 MB max HTTP response");
  });
});

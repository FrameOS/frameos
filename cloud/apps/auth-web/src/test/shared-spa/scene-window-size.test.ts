// A scene's own window size on a desktop (frontend/src/utils/sceneWindowSize.ts):
// "WxH" in `settings.windowSize`, which a desktop layout opens the scene's window
// at (docs/scene-layouts.md "Windows").

import { describe, expect, it } from "vitest";
import {
  parseWindowSize,
  sceneWindowSizeFromSelect,
  sceneWindowSizeOptions,
  sceneWindowSizeSelectValue,
} from "../../../../../../frontend/src/utils/sceneWindowSize";

describe("parseWindowSize", () => {
  it("reads WxH, each side 64 to 4096", () => {
    expect(parseWindowSize("480x480")).toEqual({ width: 480, height: 480 });
    expect(parseWindowSize(" 800 × 480 ")).toEqual({ width: 800, height: 480 });
    expect(parseWindowSize("1280X720")).toEqual({ width: 1280, height: 720 });
  });

  it("refuses anything else", () => {
    for (const value of ["", "max", "480", "480x", "10x480", "480x5000", "-1x480", 480, null, undefined, { w: 1 }]) {
      expect(parseWindowSize(value)).toBeNull();
    }
  });
});

describe("the Window size select", () => {
  it("is the desktop's (no key) until a size is picked", () => {
    expect(sceneWindowSizeSelectValue(undefined)).toBe("");
    expect(sceneWindowSizeSelectValue("nonsense")).toBe("");
    expect(sceneWindowSizeFromSelect("")).toBeUndefined();
    expect(sceneWindowSizeFromSelect("480x480")).toBe("480x480");
    expect(sceneWindowSizeSelectValue(" 480 x 800 ")).toBe("480x800");
  });

  it("offers the desktop's first, the presets, and a size of the scene's own that is none of them", () => {
    const options = sceneWindowSizeOptions();
    expect(options[0]).toEqual({ value: "", label: "The desktop's" });
    expect(options.map((option) => option.value)).toContain("480x480");
    expect(options.every((option) => option.value === "" || parseWindowSize(option.value) !== null)).toBe(true);
    expect(sceneWindowSizeOptions("480x480")).toHaveLength(options.length);
    const own = sceneWindowSizeOptions("333x222");
    expect(own).toHaveLength(options.length + 1);
    expect(own[own.length - 1]).toEqual({ value: "333x222", label: "333 × 222" });
  });
});

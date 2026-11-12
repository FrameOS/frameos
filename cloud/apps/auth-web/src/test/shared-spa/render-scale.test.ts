// The render scale (frontend/src/utils/renderScale.ts): what a UI from a
// .tsx/.jsx app is laid out for. The automatic rule is the runtime's
// (frameos/src/frameos/render_scale.nim): 1, and 2 on a 4K or larger screen
// on HDMI.

import { describe, expect, it } from "vitest";
import {
  autoRenderScale,
  automaticRenderScaleLabel,
  frameRenderScaleOptions,
  frameRenderScaleSelectValue,
  parseRenderScale,
  renderScaleFieldIndex,
  sceneRenderScaleFromSelect,
  sceneRenderScaleOptions,
  sceneRenderScaleSelectValue,
} from "../../../../../../frontend/src/utils/renderScale";
import type { StateField } from "../../../../../../frontend/src/types";

describe("autoRenderScale", () => {
  it.each([
    [800, 480, "waveshare.EPD_3in97", 1],
    [1200, 1600, "waveshare.EPD_13in3e", 1],
    [1920, 1080, "framebuffer", 1],
    [2560, 1440, "framebuffer", 1],
    [3840, 2160, "framebuffer", 2],
    [2160, 3840, "framebuffer", 2],
    [7680, 4320, "framebuffer", 2],
    [3840, 2160, "web_only", 1],
  ])("%ix%i on %s is %d×", (width, height, device, scale) => {
    expect(autoRenderScale(width, height, device)).toBe(scale);
  });

  it("is 1 for a panel of unknown size or kind", () => {
    expect(autoRenderScale(0, 0, "framebuffer")).toBe(1);
    expect(autoRenderScale(Number.NaN, 480, "framebuffer")).toBe(1);
    expect(autoRenderScale(3840, 2160)).toBe(1);
  });
});

describe("the Scale selects", () => {
  it("name the automatic scale on this panel, or just Automatic", () => {
    expect(automaticRenderScaleLabel(3840, 2160, "framebuffer")).toBe("Automatic (2× on this panel)");
    expect(automaticRenderScaleLabel(1200, 1600, "waveshare.EPD_13in3e")).toBe("Automatic (1× on this panel)");
    expect(automaticRenderScaleLabel(800, 480)).toBe("Automatic (1× on this panel)");
    expect(automaticRenderScaleLabel(undefined, 480)).toBe("Automatic");
    expect(automaticRenderScaleLabel("", "")).toBe("Automatic");
  });

  it("offer automatic and the steps for a frame", () => {
    expect(frameRenderScaleOptions(3840, 2160, "framebuffer")).toEqual([
      { label: "Automatic (2× on this panel)", value: "0" },
      { label: "0.25×", value: "0.25" },
      { label: "0.5×", value: "0.5" },
      { label: "0.75×", value: "0.75" },
      { label: "1× (as designed)", value: "1" },
      { label: "1.25×", value: "1.25" },
      { label: "1.5×", value: "1.5" },
      { label: "2×", value: "2" },
      { label: "2.5×", value: "2.5" },
      { label: "3×", value: "3" },
      { label: "4×", value: "4" },
    ]);
    // A scale set through the API stays selectable as itself.
    expect(frameRenderScaleOptions(800, 480, "waveshare.EPD_3in97", 1.75).map((option) => option.value)).toEqual([
      "0", "0.25", "0.5", "0.75", "1", "1.25", "1.5", "1.75", "2", "2.5", "3", "4",
    ]);
    expect(frameRenderScaleSelectValue(undefined)).toBe("0");
    expect(frameRenderScaleSelectValue(0)).toBe("0");
    expect(frameRenderScaleSelectValue(2.5)).toBe("2.5");
  });

  it("offer the frame's scale and the steps for a scene, and drop the setting for the frame's", () => {
    expect(sceneRenderScaleOptions()[0]).toEqual({ label: "The frame's", value: "" });
    expect(sceneRenderScaleSelectValue(undefined)).toBe("");
    expect(sceneRenderScaleSelectValue(0)).toBe("");
    expect(sceneRenderScaleSelectValue(1.5)).toBe("1.5");
    expect(sceneRenderScaleFromSelect("")).toBeUndefined();
    expect(sceneRenderScaleFromSelect("0")).toBeUndefined();
    expect(sceneRenderScaleFromSelect("2")).toBe(2);
  });
});

describe("parseRenderScale", () => {
  it("takes numbers and the strings forms hold, up to 4", () => {
    expect(parseRenderScale(1.5)).toBe(1.5);
    expect(parseRenderScale(" 2 ")).toBe(2);
    expect(parseRenderScale(4)).toBe(4);
    expect(parseRenderScale(4.5)).toBe(0);
    expect(parseRenderScale(-1)).toBe(0);
    expect(parseRenderScale("auto")).toBe(0);
    expect(parseRenderScale("")).toBe(0);
    expect(parseRenderScale(null)).toBe(0);
  });
});

describe("renderScaleFieldIndex", () => {
  it("finds the first field with the role", () => {
    const fields: StateField[] = [
      { label: "Title", name: "title", type: "string" },
      { label: "Zoom", name: "zoom", role: "renderScale", type: "float" },
      { label: "Other", name: "other", role: "renderScale", type: "float" },
    ];
    expect(renderScaleFieldIndex(fields)).toBe(1);
    expect(renderScaleFieldIndex([])).toBe(-1);
    expect(renderScaleFieldIndex(undefined)).toBe(-1);
  });
});

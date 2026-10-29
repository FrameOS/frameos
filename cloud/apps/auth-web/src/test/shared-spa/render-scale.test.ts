// The render scale (frontend/src/utils/renderScale.ts): what a UI from a
// .tsx/.jsx app is laid out for. The automatic rule is the runtime's
// (frameos/src/frameos/render_scale.nim): the panel's shorter edge over
// 600 px, rounded DOWN to a quarter, never below 1, so a scaled layout never
// has less than 600 px on its shorter edge.

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
    [800, 480, 1],
    [720, 720, 1],
    [984, 1304, 1.5],
    [1080, 1920, 1.75],
    [1200, 1600, 2],
    [1404, 1872, 2.25],
    [1872, 1404, 2.25],
    [2160, 3840, 3.5],
  ])("%ix%i is %d×", (width, height, scale) => {
    expect(autoRenderScale(width, height)).toBe(scale);
  });

  it("is 1 for a panel of unknown size", () => {
    expect(autoRenderScale(0, 0)).toBe(1);
    expect(autoRenderScale(Number.NaN, 480)).toBe(1);
  });
});

describe("the Scale selects", () => {
  it("name the automatic scale on this panel, or just Automatic", () => {
    expect(automaticRenderScaleLabel(1200, 1600)).toBe("Automatic (2× on this panel)");
    expect(automaticRenderScaleLabel(1404, 1872)).toBe("Automatic (2.25× on this panel)");
    expect(automaticRenderScaleLabel(800, 480)).toBe("Automatic (1× on this panel)");
    expect(automaticRenderScaleLabel(undefined, 480)).toBe("Automatic");
    expect(automaticRenderScaleLabel("", "")).toBe("Automatic");
  });

  it("offer automatic and the steps for a frame", () => {
    expect(frameRenderScaleOptions(1200, 1600)).toEqual([
      { label: "Automatic (2× on this panel)", value: "0" },
      { label: "1× (as designed)", value: "1" },
      { label: "1.25×", value: "1.25" },
      { label: "1.5×", value: "1.5" },
      { label: "2×", value: "2" },
      { label: "2.5×", value: "2.5" },
      { label: "3×", value: "3" },
      { label: "4×", value: "4" },
    ]);
    // A scale set through the API stays selectable as itself.
    expect(frameRenderScaleOptions(800, 480, 1.75).map((option) => option.value)).toEqual([
      "0", "1", "1.25", "1.5", "1.75", "2", "2.5", "3", "4",
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

// What a path field's picker offers on each kind of frame
// (frontend/src/utils/pathExtensions.ts): an ESP32 decodes no QOI or PPM.
import { describe, expect, it } from "vitest";
import { extensionsForFrame } from "../../../../../../frontend/src/utils/pathExtensions";

const LOCAL_IMAGE = ["jpg", "jpeg", "png", "gif", "bmp", "webp", "qoi", "ppm", "svg"];

describe("extensionsForFrame", () => {
  it("offers a Pi the whole list", () => {
    expect(extensionsForFrame(LOCAL_IMAGE, false)).toEqual(LOCAL_IMAGE);
  });

  it("leaves QOI and PPM out on an ESP32, however they are written", () => {
    expect(extensionsForFrame(LOCAL_IMAGE, true)).toEqual(["jpg", "jpeg", "png", "gif", "bmp", "webp", "svg"]);
    expect(extensionsForFrame([".QOI", "Ppm", "png"], true)).toEqual(["png"]);
  });

  it("keeps an absent or empty list meaning any file", () => {
    expect(extensionsForFrame(undefined, true)).toBeUndefined();
    expect(extensionsForFrame([], true)).toEqual([]);
  });
});

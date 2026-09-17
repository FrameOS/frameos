import { describe, expect, it } from "vitest";
import { pixelsAreBlank } from "../../../../../../frontend/src/utils/blankImage";

function pixels(...rgba: Array<[number, number, number, number]>): Uint8ClampedArray {
  return new Uint8ClampedArray(rgba.flat());
}

// Old and broken scene saves uploaded a cover before anything was drawn. The
// Add scene lists show the placeholder for those instead of a white square.
describe("pixelsAreBlank", () => {
  it("calls a flat fill blank, JPEG noise included", () => {
    expect(pixelsAreBlank(pixels([255, 255, 255, 255], [255, 255, 255, 255]))).toBe(true);
    expect(pixelsAreBlank(pixels([0, 0, 0, 255], [3, 2, 4, 255]))).toBe(true);
  });

  it("calls a fully transparent image blank", () => {
    expect(pixelsAreBlank(pixels([10, 200, 30, 0], [200, 10, 30, 0]))).toBe(true);
    expect(pixelsAreBlank(new Uint8ClampedArray(0))).toBe(true);
  });

  it("keeps anything with a picture in it", () => {
    expect(pixelsAreBlank(pixels([255, 255, 255, 255], [255, 255, 255, 255], [20, 20, 20, 255]))).toBe(false);
    // Transparent pixels don't count, but one differing opaque pixel does.
    expect(pixelsAreBlank(pixels([0, 0, 0, 0], [255, 255, 255, 255], [255, 0, 0, 255]))).toBe(false);
  });
});

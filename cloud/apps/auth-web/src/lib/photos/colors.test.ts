import { describe, expect, it } from "vitest";
import { maxPhotoColorsBytes, parsePhotoColors } from "./colors";

// docs/photos.md "POST /api/photos/colors": an object (stored as sent), null
// or {} to remove, 400 for anything else, 413 over 64 KB as JSON.
describe("parsePhotoColors", () => {
  it("keeps an object as it was sent, unknown keys included", () => {
    const colors = { future: { anything: [1, 2] }, saturation: 20, whites: -30 };
    expect(parsePhotoColors(colors)).toEqual({ colors });
  });

  it("reads null and an empty object as no profile", () => {
    expect(parsePhotoColors(null)).toEqual({ colors: null });
    expect(parsePhotoColors({})).toEqual({ colors: null });
  });

  it("refuses anything that is not a JSON object", () => {
    for (const value of [undefined, [], [{ whites: 1 }], "whites", 3, true, false]) {
      expect(parsePhotoColors(value), JSON.stringify(value)).toEqual({
        error: "invalid_colors",
        status: 400,
      });
    }
  });

  it("caps the profile at 64 KB of UTF-8 as JSON", () => {
    // {"k":"..."} is 8 bytes around the string.
    const fits = { k: "a".repeat(maxPhotoColorsBytes - 8) };
    expect(Buffer.byteLength(JSON.stringify(fits))).toBe(maxPhotoColorsBytes);
    expect(parsePhotoColors(fits)).toEqual({ colors: fits });
    expect(parsePhotoColors({ k: "a".repeat(maxPhotoColorsBytes - 7) })).toEqual({
      error: "colors_too_large",
      status: 413,
    });
    // Bytes, not characters: "é" is two.
    expect(parsePhotoColors({ k: "é".repeat(maxPhotoColorsBytes / 2) })).toMatchObject({
      status: 413,
    });
  });
});

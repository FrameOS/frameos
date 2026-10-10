import { describe, expect, it } from "vitest";
import {
  applyAssetColors,
  autoEndPoints,
  paletteRange,
} from "../../../../../../frontend/src/utils/assetColors/adjust";
import {
  SPECTRA6_PALETTE,
  panelPaletteForFrame,
  panelPaletteKindForDevice,
  visiblePalette,
} from "../../../../../../frontend/src/utils/assetColors/devicePalette";
import {
  ditherJitterFor,
  ditherPaletteIndices,
  ditherToPalette,
} from "../../../../../../frontend/src/utils/assetColors/dither";
import {
  defaultAssetColorProfile,
  parseAssetColorProfile,
  profileHasAdjustments,
  profileIsDefault,
  serializeAssetColorProfile,
  sidecarImagePath,
  sidecarPathFor,
} from "../../../../../../frontend/src/utils/assetColors/profile";

// The same test photo as frameos/src/frameos/utils/tests/test_asset_colors.nim
// builds: red ramps across, green ramps down, blue fixed.
function gradient(width: number, height: number): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      pixels[offset] = Math.floor((x * 255) / Math.max(width - 1, 1));
      pixels[offset + 1] = Math.floor((y * 255) / Math.max(height - 1, 1));
      pixels[offset + 2] = 96;
      pixels[offset + 3] = 255;
    }
  }
  return pixels;
}

function rgbOf(pixels: Uint8ClampedArray): number[] {
  const out: number[] = [];
  for (let i = 0; i < pixels.length; i += 4) {
    out.push(pixels[i] ?? -1, pixels[i + 1] ?? -1, pixels[i + 2] ?? -1);
  }
  return out;
}

function profileOf(colors: Record<string, unknown>) {
  const profile = parseAssetColorProfile({ version: 1, colors });
  if (!profile) {
    throw new Error("profile did not parse");
  }
  return profile;
}

describe("asset color profiles", () => {
  it("names the sidecar after the image", () => {
    expect(sidecarPathFor("photos/cat.jpg")).toBe("photos/cat.jpg.frameos.json");
    expect(sidecarImagePath("photos/cat.jpg.frameos.json")).toBe("photos/cat.jpg");
    expect(sidecarImagePath("photos/cat.jpg")).toBeNull();
  });

  it("parses, clamps and round-trips through the sidecar JSON", () => {
    const profile = profileOf({
      exposure: "1.5",
      contrast: 250,
      whites: -40,
      novel: 1,
      shadows: { luminance: 10, r: -5 },
      hues: { blue: { saturation: 30 } },
      palette: ["#191426", "#b2c1c0", "#c7bb00", "#6b1119", "#18539a", "#2a5531"],
    });
    expect(profile.exposure).toBe(1.5);
    expect(profile.contrast).toBe(100);
    expect(profile.whites).toBe(-40);
    expect(parseAssetColorProfile({ version: 1, colors: { hues: { red: { hue: 400 } } } })?.hues.red.hue).toBe(180);
    expect(profile.shadows).toEqual({ luminance: 10, r: -5, g: 0, b: 0 });
    expect(profile.hues.blue.saturation).toBe(30);
    expect(profile.palette?.[0]).toEqual([0x19, 0x14, 0x26]);
    expect(profileHasAdjustments(profile)).toBe(true);
    const again = parseAssetColorProfile(JSON.parse(serializeAssetColorProfile(profile)));
    expect(again).toEqual(profile);
    // Neutral sliders stay out of the file.
    const text = serializeAssetColorProfile(defaultAssetColorProfile());
    expect(JSON.parse(text)).toEqual({ version: 1, colors: {} });
    expect(profileIsDefault(defaultAssetColorProfile())).toBe(true);
    expect(parseAssetColorProfile({ version: 1 })).toBeNull();
    expect(parseAssetColorProfile({ version: 1, colors: { palette: ["#191426", "nope"] } })?.palette).toBeNull();
  });

  it("leaves a photo alone without adjustments", () => {
    const pixels = gradient(6, 4);
    const before = rgbOf(pixels);
    applyAssetColors(pixels, defaultAssetColorProfile());
    expect(rgbOf(pixels)).toEqual(before);
  });

  it("matches the runtime's arithmetic pixel for pixel", () => {
    // The vector frameos/src/frameos/utils/tests/test_asset_colors.nim pins
    // ("parity vector for the frontend preview").
    const profile = profileOf({
      exposure: 0.4,
      contrast: 25,
      whites: -30,
      blacks: 15,
      saturation: 20,
      shadows: { luminance: -10, b: 20 },
      midtones: { r: 10 },
      highlights: { luminance: 15, g: -10 },
      hues: {
        red: { hue: 40, saturation: -30, luminance: 20 },
        green: { hue: -50, saturation: 60, luminance: -20 },
        blue: { luminance: 30 },
      },
    });
    const pixels = gradient(4, 3);
    applyAssetColors(pixels, profile);
    expect(rgbOf(pixels)).toEqual([
      0, 0, 192, 109, 0, 142, 248, 8, 109, 247, 14, 105, 0, 160, 83, 116, 177, 87, 240, 190, 130, 248, 198, 135, 0, 238,
      1, 190, 255, 71, 252, 255, 110, 255, 255, 114,
    ]);
  });

  it("pulls the highlights under the panel's white with negative whites", () => {
    const pixels = new Uint8ClampedArray([255, 255, 255, 255]);
    applyAssetColors(pixels, profileOf({ whites: -100 }));
    expect(Array.from(pixels)).toEqual([182, 182, 182, 255]);
  });

  it("turns the Auto preset into Whites and Blacks that fit the panel", () => {
    expect(paletteRange(SPECTRA6_PALETTE).hi).toBeCloseTo(0.744, 2);
    const pixels = gradient(16, 16);
    const auto = autoEndPoints(pixels, SPECTRA6_PALETTE);
    expect(auto).not.toBeNull();
    // Brighter than the panel's white → pulled down; the floor lifted to the palette's black.
    expect(auto!.whites).toBeLessThan(-50);
    expect(auto!.blacks).toBeGreaterThan(0);
    // Applying those sliders lands the brightest pixel near the panel's white.
    applyAssetColors(pixels, { ...defaultAssetColorProfile(), ...auto! });
    const last = (16 * 16 - 1) * 4;
    const lum = (0.21 * (pixels[last] ?? 0) + 0.72 * (pixels[last + 1] ?? 0) + 0.07 * (pixels[last + 2] ?? 0)) / 255;
    expect(Math.abs(lum - 0.744)).toBeLessThan(0.06);
    // A flat image has nothing to fit; `auto` in an old sidecar is ignored.
    expect(autoEndPoints(new Uint8ClampedArray([9, 9, 9, 255, 9, 9, 9, 255]), SPECTRA6_PALETTE)).toBeNull();
    expect(parseAssetColorProfile({ version: 1, colors: { auto: true } })).toEqual(defaultAssetColorProfile());
  });
});

describe("panel dither port", () => {
  it("hashes the jitter like the runtime", () => {
    expect(ditherJitterFor(0, 8)).toBe(-8);
    for (let index = 0; index < 1000; index++) {
      const jitter = ditherJitterFor(index, 8);
      expect(jitter).toBeGreaterThanOrEqual(-8);
      expect(jitter).toBeLessThanOrEqual(8);
    }
  });

  it("reproduces the runtime's index vector exactly", () => {
    // frameos/src/frameos/utils/tests/test_asset_colors.nim, "dither parity
    // vector": forEachPaletteDithered on the 8x4 gradient, Spectra table.
    const indices = ditherPaletteIndices(gradient(8, 4), 8, 4, SPECTRA6_PALETTE);
    expect(Array.from(indices)).toEqual([
      0, 0, 0, 3, 3, 3, 3, 3, 5, 5, 5, 5, 1, 3, 1, 3, 6, 6, 1, 2, 1, 1, 2, 1, 5, 6, 6, 1, 2, 1, 2, 1,
    ]);
  });

  it("paints the palette's own colors and never the placeholder", () => {
    const pixels = gradient(8, 4);
    const out = new Uint8ClampedArray(pixels.length);
    ditherToPalette(pixels, 8, 4, SPECTRA6_PALETTE, out);
    for (let i = 0; i < out.length; i += 4) {
      const match = SPECTRA6_PALETTE.some(
        ([r, g, b]) => r === out[i] && g === out[i + 1] && b === out[i + 2],
      );
      expect(match).toBe(true);
      expect(out[i]).toBeLessThan(999);
      expect(out[i + 3]).toBe(255);
    }
  });
});

describe("panel palette for a frame", () => {
  it("knows the panel families by device name", () => {
    expect(panelPaletteKindForDevice("waveshare.EPD_13in3e")).toBe("spectra6");
    expect(panelPaletteKindForDevice("pimoroni.inky_impression_7")).toBe("spectra6");
    expect(panelPaletteKindForDevice("pimoroni.inky_impression_7_3")).toBe("sevenColor");
    expect(panelPaletteKindForDevice("waveshare.EPD_7in3f", 'Waveshare 7.3" (F) 800x480 7 Color')).toBe("sevenColor");
    expect(panelPaletteKindForDevice("waveshare.EPD_2in13g")).toBe("fourColor");
    expect(panelPaletteKindForDevice("waveshare.EPD_7in5b_V2")).toBe("blackWhiteRed");
    expect(panelPaletteKindForDevice("waveshare.EPD_7in5_V2")).toBe("blackWhite");
    expect(panelPaletteKindForDevice("framebuffer")).toBe("none");
    expect(panelPaletteKindForDevice("web_only")).toBe("none");
  });

  it("prefers a frame's six-color custom palette on a Spectra panel", () => {
    const custom = ["#000000", "#ffffff", "#ffff00", "#ff0000", "#0000ff", "#00ff00"];
    const palette = panelPaletteForFrame({ device: "waveshare.EPD_7in3e", palette: { colors: custom } });
    expect(palette).toHaveLength(7);
    expect(palette?.[4]).toEqual([999, 999, 999]);
    expect(visiblePalette(palette)).toEqual([
      [0, 0, 0],
      [255, 255, 255],
      [255, 255, 0],
      [255, 0, 0],
      [0, 0, 255],
      [0, 255, 0],
    ]);
    // Not on a seven-color one.
    expect(panelPaletteForFrame({ device: "waveshare.EPD_7in3f", palette: { colors: custom } })).toHaveLength(7);
    expect(panelPaletteForFrame({ device: "waveshare.EPD_7in3f", palette: { colors: custom } })?.[4]).toEqual([
      156, 72, 75,
    ]);
    expect(panelPaletteForFrame({ device: "framebuffer" })).toBeNull();
    expect(
      panelPaletteForFrame({
        device: "virtual",
        embedded: { platform: "virtual" },
        device_config: { colorMode: "bw" },
      }),
    ).toEqual([
      [0, 0, 0],
      [255, 255, 255],
    ]);
  });
});

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { describe, expect, it } from "vitest";

import {
  createOpenDisplayDitherer,
  dbsMaxPixels,
  defaultPanelPpi,
  ditherProblem,
  normalizeDither,
  openDisplayDitherer,
  openDisplayDithererSource,
  openDisplayModulePath,
  panelDiagonalInches,
  panelPpi,
} from "./panel-dither";
import { packForPanel, panelPackerSource, type PanelPalette, type PanelPixelFormatCode, spectra6Palette } from "./panel-pack";

// docs/dither-fixtures.json: the backend writes it (backend/app/utils/tests/
// test_panel_dither.py) and replays it; this replays the same cases through
// the npm package's WASM build of the same Rust core.
type DitherCase = {
  dither: unknown;
  height: number;
  name: string;
  packed: string;
  palette: (string | null)[];
  pixelFormat: number;
  ppi: number;
  rgb: string;
  width: number;
};
const corpus = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../../../docs/dither-fixtures.json", import.meta.url)), "utf8"),
) as { cases: DitherCase[] };

function rgbaFromHex(rgbHex: string, width: number, height: number): Uint8Array {
  const rgb = Buffer.from(rgbHex, "hex");
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    rgba[i * 4] = rgb[i * 3]!;
    rgba[i * 4 + 1] = rgb[i * 3 + 1]!;
    rgba[i * 4 + 2] = rgb[i * 3 + 2]!;
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}

function paletteFromHex(colors: (string | null)[]): PanelPalette {
  return colors.map((hex) =>
    hex === null
      ? null
      : ([parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)] as const),
  );
}

function sampleRgba(width: number, height: number): Uint8Array {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 4;
      rgba[at] = (x * 255) / (width - 1);
      rgba[at + 1] = (y * 255) / (height - 1);
      rgba[at + 2] = ((x + y) * 127) / (width + height);
      rgba[at + 3] = 255;
    }
  }
  return rgba;
}

describe("OpenDisplay dithering (docs/dither-fixtures.json)", () => {
  it("has the package", () => {
    expect(openDisplayModulePath()).not.toBeNull();
  });

  for (const testCase of corpus.cases) {
    it(`packs what the backend packs: ${testCase.name}`, () => {
      const dither = normalizeDither(testCase.dither);
      expect(dither).toEqual(testCase.dither);
      const ditherer = openDisplayDitherer(dither, testCase.ppi);
      expect(ditherer).not.toBeNull();
      const rgba = rgbaFromHex(testCase.rgb, testCase.width, testCase.height);
      const palette = paletteFromHex(testCase.palette);
      const packed = packForPanel(
        rgba,
        testCase.width,
        testCase.height,
        testCase.pixelFormat as PanelPixelFormatCode,
        palette,
        ditherer,
      );
      expect(Buffer.from(packed).toString("hex")).toBe(testCase.packed);
      // Deterministic: the ETag of an unchanged picture must not move.
      const again = packForPanel(rgba, testCase.width, testCase.height, testCase.pixelFormat as PanelPixelFormatCode, palette, ditherer);
      expect(Buffer.from(again).toString("hex")).toBe(testCase.packed);
    });
  }
});

describe("the ditherer and the packer", () => {
  it("defaults to Floyd-Steinberg", () => {
    const rgba = sampleRgba(16, 12);
    const fs = packForPanel(rgba, 16, 12, 7, spectra6Palette);
    expect(packForPanel(rgba, 16, 12, 7, spectra6Palette, null)).toEqual(fs);
    expect(packForPanel(rgba, 16, 12, 7, spectra6Palette, openDisplayDitherer(normalizeDither({ method: "opendisplay" }), defaultPanelPpi))).not.toEqual(fs);
  });

  it("falls back to Floyd-Steinberg when the ditherer cannot run", () => {
    const rgba = sampleRgba(16, 12);
    const fs = packForPanel(rgba, 16, 12, 7, spectra6Palette);
    const broken = createOpenDisplayDitherer(
      {
        Palette: { fromSrgb: () => ({}) },
        ditherImage: () => {
          throw new Error("no core");
        },
      },
      normalizeDither({ method: "opendisplay" })!,
      defaultPanelPpi,
      dbsMaxPixels,
    );
    expect(packForPanel(rgba, 16, 12, 7, spectra6Palette, broken)).toEqual(fs);
  });

  it("builds from its text in an empty context, as the render worker does", () => {
    const context = vm.createContext({ Uint8ClampedArray, Math, Number });
    const build = vm.runInContext(`(${openDisplayDithererSource})`, context) as typeof createOpenDisplayDitherer;
    const packer = vm.runInContext(`(${panelPackerSource})()`, vm.createContext({ Uint8Array, Float32Array, Math, Number, Error })) as {
      packForPanel: typeof packForPanel;
    };
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const od = require(openDisplayModulePath()!) as Parameters<typeof createOpenDisplayDitherer>[0];
    const dither = normalizeDither({ method: "opendisplay", dbs: true })!;
    const rgba = sampleRgba(16, 12);
    const inWorker = packer.packForPanel(rgba, 16, 12, 7, spectra6Palette, build(od, dither, defaultPanelPpi, dbsMaxPixels));
    const here = packForPanel(rgba, 16, 12, 7, spectra6Palette, openDisplayDitherer(dither, defaultPanelPpi));
    expect(Buffer.from(inWorker)).toEqual(Buffer.from(here));
  });
});

describe("the dither setting", () => {
  it("normalizes like panel_dither.py", () => {
    expect(normalizeDither(null)).toBeNull();
    expect(normalizeDither({ method: "floydSteinberg", dbs: true })).toBeNull();
    expect(normalizeDither({ method: "opendisplay" })).toEqual({
      method: "opendisplay",
      algorithm: "burkes",
      dbs: false,
      exposure: 1,
      viewingDistanceCm: 30,
      saturation: 1,
      shadows: 0,
      highlights: 0,
      tone: 0,
      gamut: 0,
      ppi: null,
    });
    expect(
      normalizeDither({ method: "opendisplay", algorithm: "nope", exposure: 9, viewingDistanceCm: true, saturation: 5, tone: -1, ppi: 10 }),
    ).toEqual({
      method: "opendisplay",
      algorithm: "burkes",
      dbs: false,
      exposure: 2,
      viewingDistanceCm: 30,
      saturation: 2,
      shadows: 0,
      highlights: 0,
      tone: 0,
      gamut: 0,
      ppi: 50,
    });
  });

  it.each([
    { method: "dbs" },
    { method: "opendisplay", algorithm: "fancy" },
    { method: "opendisplay", dbs: "yes" },
    { method: "opendisplay", exposure: 3 },
    { method: "opendisplay", viewingDistanceCm: 2 },
    { method: "opendisplay", colour: "red" },
    { method: "opendisplay", saturation: 2.5 },
    { method: "opendisplay", gamut: -0.1 },
    { method: "opendisplay", ppi: 20 },
    { method: "opendisplay", tone: "a bit" },
    ["opendisplay"],
  ])("refuses %j", (value) => {
    expect(ditherProblem(value)).not.toBeNull();
  });

  it("accepts", () => {
    expect(ditherProblem(null)).toBeNull();
    expect(
      ditherProblem({ method: "opendisplay", algorithm: "stucki", dbs: true, exposure: 1.3, viewingDistanceCm: 80 }),
    ).toBeNull();
    expect(
      ditherProblem({ method: "opendisplay", saturation: 0, shadows: 1, highlights: 0.5, tone: 0.2, gamut: 1, ppi: null }),
    ).toBeNull();
    expect(ditherProblem({ method: "opendisplay", ppi: 180 })).toBeNull();
  });

  it("reads the panel's size from its name", () => {
    expect(panelDiagonalInches("EPD_7in3e")).toBe(7.3);
    expect(panelDiagonalInches("waveshare.EPD_13in3e")).toBe(13.3);
    expect(panelDiagonalInches("pimoroni.inky_impression_4")).toBe(4);
    expect(panelDiagonalInches("embedded")).toBeNull();
    expect(Math.round(panelPpi("EPD_7in3e", 800, 480))).toBe(128);
    expect(Math.round(panelPpi("EPD_4in0e", 600, 400))).toBe(180);
    expect(panelPpi(null, 800, 480)).toBe(defaultPanelPpi);
  });
});

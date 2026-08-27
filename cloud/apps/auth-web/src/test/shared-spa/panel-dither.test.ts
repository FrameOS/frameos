// The preview's "how it looks on the frame" filter is the device's own
// Floyd–Steinberg, ported to TypeScript (frameos/wasm/src/dither.ts from
// frameos/src/frameos/utils/dither.nim). Its whole value is that it agrees
// with the driver: a preview that dithers *nearly* like the panel is a
// preview that lies.
//
// These digests come from the Nim side. The harness that produced them —
// the same picture through `forEachPaletteDithered` / `forEachGrayDithered`,
// written out as raw RGB — is reproducible:
//
//   1. Build the picture below in Nim (same integer maths, RGBA image).
//   2. For each palette, write palette[index] per pixel; for each grey
//      depth, write round(level / maxLevel * 255) three times.
//   3. sha256 the W*H*3 bytes.
//
// All eight matched byte for byte when the port was written (2026-08-28).
// A digest changing here means the port drifted from the device — or that
// the device's dither changed, in which case fix the port and re-run the
// harness rather than editing the number.

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ditherFrame, panelPalettes } from "frameos-wasm";

const WIDTH = 97;
const HEIGHT = 61;

const digests: Record<string, string> = {
  blackWhite: "ad045e600895dcdf3fbee8bcd8d05e4e32cda449d08ad4e95c8b54232ed372a4",
  blackWhiteRed: "4a4db3f7b19c5e657a8e0940c181545c0d47998f6aecbc7fe9a663f024c429e9",
  blackWhiteYellow: "8c7b6db4642b98cd6f0ecbb4ba6958f7a378dc92225b6ee740fd29f8cf0d8115",
  fourColor: "512f5ca7e940c4b6397afa2b50c6108efc0e7d679976636b0c35031b45c87a15",
  fourGray: "f6c4d92b2c984d888f0c148816df5aff2e8461e6ea823aa7976f4c1feda7754f",
  sevenColor: "c7c1a30a6e76088371b6f8ac91235b1682d7888f85e52d9ed31bcacc81bfd5c5",
  sixteenGray: "dcffd0ccf3590a5b36f5390fb74c5c1d6143e8715bda2be81d77c63e2eaf63b5",
  spectra6: "48b4d0b1b3b3b789c7cf18c9545f40c42b6c30add22c5ea5124e4f3d912ec496",
};

// Gradients in all three channels (where the threshold jitter earns its
// keep) plus flat blocks of saturated ink, near-white and near-black (where
// the nearest-colour search and its tie-breaking show).
function buildFrame(): Uint8ClampedArray {
  const data = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      let r = Math.floor((x * 255) / (WIDTH - 1));
      let g = Math.floor((y * 255) / (HEIGHT - 1));
      let b = Math.floor(((x + y) * 255) / (WIDTH + HEIGHT - 2));
      if (x >= 10 && x < 25 && y >= 10 && y < 25) {
        [r, g, b] = [255, 0, 0];
      } else if (x >= 30 && x < 45 && y >= 10 && y < 25) {
        [r, g, b] = [250, 250, 250];
      } else if (x >= 50 && x < 65 && y >= 10 && y < 25) {
        [r, g, b] = [0, 90, 40];
      } else if (x >= 70 && x < 85 && y >= 30 && y < 45) {
        [r, g, b] = [18, 18, 18];
      }
      const at = (y * WIDTH + x) * 4;
      data[at] = r;
      data[at + 1] = g;
      data[at + 2] = b;
      data[at + 3] = 255;
    }
  }
  return data;
}

function ditheredRgbDigest(key: string): string {
  const panel = panelPalettes.find((entry) => entry.key === key)!;
  const data = buildFrame();
  ditherFrame(data, WIDTH, HEIGHT, panel);
  const rgb = Buffer.alloc(WIDTH * HEIGHT * 3);
  for (let pixel = 0; pixel < WIDTH * HEIGHT; pixel += 1) {
    rgb[pixel * 3] = data[pixel * 4]!;
    rgb[pixel * 3 + 1] = data[pixel * 4 + 1]!;
    rgb[pixel * 3 + 2] = data[pixel * 4 + 2]!;
  }
  return createHash("sha256").update(rgb).digest("hex");
}

describe("the preview's panel dither", () => {
  it("offers every panel the drivers render for", () => {
    // panelPalettes is in picker order (colour panels, then greys); this
    // only cares that the set is the same one the digests below cover.
    expect([...panelPalettes.map((panel) => panel.key)].sort()).toEqual(
      Object.keys(digests).sort(),
    );
  });

  for (const key of Object.keys(digests).sort()) {
    it(`renders ${key} exactly as the device does`, () => {
      expect(ditheredRgbDigest(key)).toBe(digests[key]);
    });
  }

  it("paints the panel's measured colours, not the sRGB ones", () => {
    // A flat near-white block on a Spectra 6 panel is that panel's white:
    // a greenish grey (178, 193, 192), which is the whole point of showing
    // the preview through it.
    const panel = panelPalettes.find((entry) => entry.key === "spectra6")!;
    const data = buildFrame();
    ditherFrame(data, WIDTH, HEIGHT, panel);
    const at = (17 * WIDTH + 37) * 4;
    expect([data[at], data[at + 1], data[at + 2]]).toEqual([178, 193, 192]);
  });

  it("leaves alpha alone", () => {
    const panel = panelPalettes.find((entry) => entry.key === "blackWhite")!;
    const data = buildFrame();
    data[3] = 128;
    ditherFrame(data, WIDTH, HEIGHT, panel);
    expect(data[3]).toBe(128);
  });
});

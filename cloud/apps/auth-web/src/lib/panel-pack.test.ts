import { describe, expect, it } from "vitest";
import {
  fosbHeaderBytes,
  fosbPayload,
  isPanelPixelFormat,
  packForPanel,
  PanelPixelFormat,
  panelBufferBytes,
  panelFosb,
  rotateRgbaClockwise,
  sceneCanvasSize,
  type PanelPixelFormatCode,
} from "./panel-pack";

function solid(width: number, height: number, rgb: readonly [number, number, number]): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    out[i * 4] = rgb[0];
    out[i * 4 + 1] = rgb[1];
    out[i * 4 + 2] = rgb[2];
    out[i * 4 + 3] = 255;
  }
  return out;
}

// A picture whose left half is one colour and right half another.
function halves(
  width: number,
  height: number,
  left: readonly [number, number, number],
  right: readonly [number, number, number],
): Uint8Array {
  const out = solid(width, height, left);
  for (let y = 0; y < height; y += 1) {
    for (let x = width / 2; x < width; x += 1) {
      const i = (y * width + x) * 4;
      out[i] = right[0];
      out[i + 1] = right[1];
      out[i + 2] = right[2];
    }
  }
  return out;
}

const allFormats = Object.values(PanelPixelFormat) as PanelPixelFormatCode[];

describe("panel buffer sizes", () => {
  it("match embedded_buffer_size for every format, odd widths rounded up per row", () => {
    expect(panelBufferBytes(800, 480, PanelPixelFormat.oneBit)).toBe(48_000);
    expect(panelBufferBytes(801, 2, PanelPixelFormat.oneBit)).toBe(101 * 2);
    expect(panelBufferBytes(800, 480, PanelPixelFormat.dualOneBitRed)).toBe(96_000);
    expect(panelBufferBytes(5, 3, PanelPixelFormat.twoBitGray)).toBe(2 * 3);
    expect(panelBufferBytes(1200, 1600, PanelPixelFormat.fourBitSpectra6)).toBe(960_000);
    expect(panelBufferBytes(3, 3, PanelPixelFormat.fourBitGray)).toBe(2 * 3);
    expect(panelBufferBytes(480, 480, PanelPixelFormat.rgb565)).toBe(460_800);
  });

  it("packs exactly that many bytes", () => {
    for (const format of allFormats) {
      for (const [width, height] of [
        [17, 5],
        [16, 16],
      ] as const) {
        const packed = packForPanel(solid(width, height, [128, 128, 128]), width, height, format);
        expect(packed.length, `format ${format} ${width}x${height}`).toBe(panelBufferBytes(width, height, format));
      }
    }
  });

  it("knows the formats and only those", () => {
    expect(allFormats.every(isPanelPixelFormat)).toBe(true);
    expect(isPanelPixelFormat(0)).toBe(false);
    expect(isPanelPixelFormat(10)).toBe(false);
    expect(isPanelPixelFormat(1.5)).toBe(false);
    expect(isPanelPixelFormat("1")).toBe(false);
  });
});

describe("bit layouts", () => {
  it("1 bpp: a set bit is white, most significant bit first", () => {
    const packed = packForPanel(halves(16, 1, [0, 0, 0], [255, 255, 255]), 16, 1, PanelPixelFormat.oneBit);
    expect([...packed]).toEqual([0x00, 0xff]);
  });

  it("dual 1 bpp: black clears the first plane, the accent the second, white neither", () => {
    const rgba = new Uint8Array([
      ...[0, 0, 0, 255],
      ...[255, 0, 0, 255],
      ...[255, 255, 255, 255],
      ...[255, 255, 255, 255],
      ...[255, 255, 255, 255],
      ...[255, 255, 255, 255],
      ...[255, 255, 255, 255],
      ...[255, 255, 255, 255],
    ]);
    const packed = packForPanel(rgba, 8, 1, PanelPixelFormat.dualOneBitRed);
    expect([...packed]).toEqual([0b01111111, 0b10111111]);
    const yellow = packForPanel(solid(8, 1, [255, 255, 0]), 8, 1, PanelPixelFormat.dualOneBitYellow);
    expect([...yellow]).toEqual([0xff, 0x00]);
  });

  it("2 bpp grey: four levels, two bits a pixel, left pixel high", () => {
    const rgba = new Uint8Array([
      ...[0, 0, 0, 255],
      ...[85, 85, 85, 255],
      ...[170, 170, 170, 255],
      ...[255, 255, 255, 255],
    ]);
    const packed = packForPanel(rgba, 4, 1, PanelPixelFormat.twoBitGray);
    expect([...packed]).toEqual([0b00011011]);
  });

  it("4 bpp grey: sixteen levels, the even pixel in the high nibble", () => {
    const rgba = new Uint8Array([...[0, 0, 0, 255], ...[255, 255, 255, 255]]);
    expect([...packForPanel(rgba, 2, 1, PanelPixelFormat.fourBitGray)]).toEqual([0x0f]);
  });

  it("greys come from luma 0.21 / 0.72 / 0.07", () => {
    // Pure green is bright (0.72), pure blue dark (0.07).
    expect([...packForPanel(solid(8, 1, [0, 255, 0]), 8, 1, PanelPixelFormat.oneBit)]).toEqual([0xff]);
    expect([...packForPanel(solid(8, 1, [0, 0, 255]), 8, 1, PanelPixelFormat.oneBit)]).toEqual([0x00]);
  });

  it("rgb565: little-endian words, truncated channels", () => {
    const packed = packForPanel(new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255]), 3, 1, PanelPixelFormat.rgb565);
    expect([...packed]).toEqual([0x00, 0xf8, 0xe0, 0x07, 0x1f, 0x00]);
  });
});

describe("palettes", () => {
  it("Spectra 6: each colour lands on its wire index, and 4 is never used", () => {
    const colours: [readonly [number, number, number], number][] = [
      [[25, 20, 38], 0],
      [[178, 193, 192], 1],
      [[199, 187, 0], 2],
      [[107, 17, 25], 3],
      [[24, 83, 154], 5],
      [[42, 85, 49], 6],
    ];
    for (const [rgb, wire] of colours) {
      const packed = packForPanel(solid(2, 1, rgb), 2, 1, PanelPixelFormat.fourBitSpectra6);
      expect(packed[0], `colour ${rgb.join(",")}`).toBe((wire << 4) | wire);
    }
    const noisy = new Uint8Array(64 * 64 * 4).map((_, index) => (index * 7919) % 251);
    const packed = packForPanel(noisy, 64, 64, PanelPixelFormat.fourBitSpectra6);
    for (const byte of packed) {
      expect(byte >> 4).not.toBe(4);
      expect(byte & 0x0f).not.toBe(4);
    }
  });

  it("BWYR at 2 bpp and seven colours at 4 bpp", () => {
    expect([...packForPanel(solid(4, 1, [208, 190, 71]), 4, 1, PanelPixelFormat.twoBitBwyr)]).toEqual([0b10101010]);
    expect([...packForPanel(solid(2, 1, [177, 106, 73]), 2, 1, PanelPixelFormat.fourBitSevenColor)]).toEqual([0x66]);
  });

  it("dithers a mid grey on a black and white panel to about half the pixels", () => {
    const width = 64;
    const height = 64;
    const packed = packForPanel(solid(width, height, [128, 128, 128]), width, height, PanelPixelFormat.oneBit);
    let white = 0;
    for (const byte of packed) {
      for (let bit = 0; bit < 8; bit += 1) {
        white += (byte >> bit) & 1;
      }
    }
    expect(white / (width * height)).toBeGreaterThan(0.45);
    expect(white / (width * height)).toBeLessThan(0.55);
  });
});

describe("rotation", () => {
  // 3x2: a b c / d e f, one byte per pixel in the red channel.
  const picture = new Uint8Array([1, 0, 0, 255, 2, 0, 0, 255, 3, 0, 0, 255, 4, 0, 0, 255, 5, 0, 0, 255, 6, 0, 0, 255]);
  const reds = (rgba: Uint8Array) => [...rgba].filter((_, index) => index % 4 === 0);

  it("turns clockwise like rotate_for_panel", () => {
    expect(reds(rotateRgbaClockwise(picture, 3, 2, 0).rgba)).toEqual([1, 2, 3, 4, 5, 6]);
    const quarter = rotateRgbaClockwise(picture, 3, 2, 90);
    expect([quarter.width, quarter.height]).toEqual([2, 3]);
    expect(reds(quarter.rgba)).toEqual([4, 1, 5, 2, 6, 3]);
    expect(reds(rotateRgbaClockwise(picture, 3, 2, 180).rgba)).toEqual([6, 5, 4, 3, 2, 1]);
    const threeQuarters = rotateRgbaClockwise(picture, 3, 2, 270);
    expect([threeQuarters.width, threeQuarters.height]).toEqual([2, 3]);
    expect(reds(threeQuarters.rgba)).toEqual([3, 6, 2, 5, 1, 4]);
  });

  it("renders a portrait frame on the swapped canvas", () => {
    expect(sceneCanvasSize(800, 480, 0)).toEqual({ height: 480, width: 800 });
    expect(sceneCanvasSize(800, 480, 90)).toEqual({ height: 800, width: 480 });
    expect(sceneCanvasSize(800, 480, 180)).toEqual({ height: 480, width: 800 });
    expect(sceneCanvasSize(800, 480, 270)).toEqual({ height: 800, width: 480 });
  });
});

describe("FOSB", () => {
  it("writes the header fos_client.c reads", () => {
    const body = fosbPayload(800, 480, PanelPixelFormat.fourBitSpectra6, new Uint8Array([9, 8]));
    expect(body.subarray(0, 4).toString("latin1")).toBe("FOSB");
    expect(body[4]).toBe(1);
    expect(body[5]).toBe(7);
    expect(body.readUInt16LE(6)).toBe(800);
    expect(body.readUInt16LE(8)).toBe(480);
    expect(body.readUInt16LE(10)).toBe(0);
    expect([...body.subarray(fosbHeaderBytes)]).toEqual([9, 8]);
  });

  it("packs a portrait scene for its landscape panel", () => {
    const canvas = sceneCanvasSize(16, 8, 90);
    const body = panelFosb(solid(canvas.width, canvas.height, [255, 255, 255]), canvas, {
      format: PanelPixelFormat.oneBit,
      height: 8,
      rotate: 90,
      width: 16,
    });
    expect(body.readUInt16LE(6)).toBe(16);
    expect(body.readUInt16LE(8)).toBe(8);
    expect(body.length).toBe(fosbHeaderBytes + 16);
    expect([...body.subarray(fosbHeaderBytes)].every((byte) => byte === 0xff)).toBe(true);
  });

  it("refuses a canvas that is not the panel's", () => {
    expect(() =>
      panelFosb(solid(16, 8, [0, 0, 0]), { height: 8, width: 16 }, { format: 1, height: 8, rotate: 90, width: 16 }),
    ).toThrow(/not a 16x8 panel/);
  });
});

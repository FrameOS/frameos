import { strToU8, zipSync, zlibSync } from "fflate";
import { describe, expect, it } from "vitest";
import { isProvablyFullyTransparentImage, validateSceneZip } from "./store";

// Minimal PNG writer for the detector tests: real chunk layout, real CRCs,
// real zlib IDAT — the pieces the detector actually parses.

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) {
    out[4 + i] = type.charCodeAt(i);
  }
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function png({
  bitDepth = 8,
  colorType = 6,
  extraChunks = [] as Uint8Array[],
  filteredData,
  height,
  interlace = 0,
  width,
}: {
  bitDepth?: number;
  colorType?: number;
  extraChunks?: Uint8Array[];
  filteredData: Uint8Array;
  height: number;
  interlace?: number;
  width: number;
}): Buffer {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter method
  ihdr[12] = interlace;
  const parts = [
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    ...extraChunks,
    chunk("IDAT", zlibSync(filteredData)),
    chunk("IEND", new Uint8Array(0)),
  ];
  return Buffer.concat(parts.map((part) => Buffer.from(part)));
}

// Filtered scanline stream from raw per-row pixel bytes: row 0 uses Sub,
// later rows use Up. This makes the FILTERED bytes deltas — a detector that
// scanned the inflated stream without unfiltering would misjudge alpha.
function filterRows(rows: number[][], channels: number): Uint8Array {
  const stride = rows[0]!.length;
  const out = new Uint8Array(rows.length * (1 + stride));
  let position = 0;
  let previous: number[] = new Array(stride).fill(0);
  rows.forEach((row, index) => {
    out[position++] = index === 0 ? 1 : 2; // Sub, then Up
    for (let x = 0; x < stride; x++) {
      const reference = index === 0 ? (x >= channels ? row[x - channels]! : 0) : previous[x]!;
      out[position++] = (row[x]! - reference) & 0xff;
    }
    previous = row;
  });
  return out;
}

function plainRows(rows: number[][]): Uint8Array {
  const stride = rows[0]!.length;
  const out = new Uint8Array(rows.length * (1 + stride));
  let position = 0;
  for (const row of rows) {
    out[position++] = 0;
    out.set(row, position);
    position += stride;
  }
  return out;
}

const transparentRgba = (width: number, height: number) =>
  png({
    filteredData: plainRows(
      Array.from({ length: height }, () => new Array(width * 4).fill(0)),
    ),
    height,
    width,
  });

describe("isProvablyFullyTransparentImage", () => {
  it("proves a fully transparent 8-bit RGBA PNG", () => {
    expect(isProvablyFullyTransparentImage(transparentRgba(3, 2))).toBe(true);
  });

  it("proves transparency across all five filter types", () => {
    // All-zero rows reconstruct to zero under every filter; make sure none
    // of the filter branches throws or misjudges.
    const stride = 3 * 4;
    const data = new Uint8Array(5 * (1 + stride));
    for (let y = 0; y < 5; y++) {
      data[y * (1 + stride)] = y; // filter types 0..4
    }
    expect(
      isProvablyFullyTransparentImage(
        png({ filteredData: data, height: 5, width: 3 }),
      ),
    ).toBe(true);
  });

  it("accepts the same PNG with a single nonzero alpha byte", () => {
    const rows = Array.from({ length: 2 }, () => new Array(3 * 4).fill(0));
    rows[1]![11] = 1; // last pixel of row 1: alpha 1
    expect(
      isProvablyFullyTransparentImage(
        png({ filteredData: plainRows(rows), height: 2, width: 3 }),
      ),
    ).toBe(false);
  });

  it("unfilters before judging: opaque pixels hidden behind filter deltas", () => {
    // Every pixel is opaque, but Sub/Up filtering leaves exactly one nonzero
    // byte in the whole filtered stream. Raw-stream scanning would call this
    // \"almost all zero\"; correct unfiltering proves it is fully opaque.
    const opaqueRow = [0, 0, 0, 255, 0, 0, 0, 255];
    expect(
      isProvablyFullyTransparentImage(
        png({
          filteredData: filterRows([opaqueRow, opaqueRow], 4),
          height: 2,
          width: 2,
        }),
      ),
    ).toBe(false);
  });

  it("proves a fully transparent greyscale+alpha PNG", () => {
    expect(
      isProvablyFullyTransparentImage(
        png({
          colorType: 4,
          filteredData: plainRows([new Array(2 * 2).fill(0)]),
          height: 1,
          width: 2,
        }),
      ),
    ).toBe(true);
  });

  it("accepts opaque color modes without inflating: RGB and palette", () => {
    expect(
      isProvablyFullyTransparentImage(
        png({
          colorType: 2,
          filteredData: plainRows([new Array(2 * 3).fill(0)]),
          height: 1,
          width: 2,
        }),
      ),
    ).toBe(false);
    expect(
      isProvablyFullyTransparentImage(
        png({
          colorType: 3,
          extraChunks: [chunk("PLTE", new Uint8Array([0, 0, 0]))],
          filteredData: plainRows([[0, 0]]),
          height: 1,
          width: 2,
        }),
      ),
    ).toBe(false);
  });

  it("accepts what it cannot prove: interlaced, 16-bit, tRNS", () => {
    expect(
      isProvablyFullyTransparentImage(
        png({
          filteredData: plainRows([new Array(2 * 4).fill(0)]),
          height: 1,
          interlace: 1,
          width: 2,
        }),
      ),
    ).toBe(false);
    expect(
      isProvablyFullyTransparentImage(
        png({
          bitDepth: 16,
          filteredData: plainRows([new Array(2 * 8).fill(0)]),
          height: 1,
          width: 2,
        }),
      ),
    ).toBe(false);
    expect(
      isProvablyFullyTransparentImage(
        png({
          extraChunks: [chunk("tRNS", new Uint8Array([0]))],
          filteredData: plainRows([new Array(2 * 4).fill(0)]),
          height: 1,
          width: 2,
        }),
      ),
    ).toBe(false);
  });

  it("accepts non-PNG bytes and malformed PNGs without throwing", () => {
    // JPEG header
    expect(
      isProvablyFullyTransparentImage(
        Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0, 0, 0, 0, 0, 0, 0, 0]),
      ),
    ).toBe(false);
    // PNG signature followed by garbage (the shape old tests upload)
    expect(
      isProvablyFullyTransparentImage(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 1]),
      ),
    ).toBe(false);
    // Valid structure but truncated IDAT: cannot prove, accept.
    const valid = transparentRgba(4, 4);
    expect(
      isProvablyFullyTransparentImage(valid.subarray(0, valid.length - 20)),
    ).toBe(false);
    // Corrupt zlib stream inside a well-formed chunk list.
    const corrupt = png({
      filteredData: plainRows([new Array(2 * 4).fill(0)]),
      height: 1,
      width: 2,
    });
    // Signature (8) + IHDR chunk (25) + IDAT length/type (8) = first byte of
    // the zlib stream; flipping it makes unzlibSync throw.
    corrupt[41] = corrupt[41]! ^ 0xff;
    expect(isProvablyFullyTransparentImage(corrupt)).toBe(false);
    // Empty / tiny buffers.
    expect(isProvablyFullyTransparentImage(Buffer.alloc(0))).toBe(false);
    expect(isProvablyFullyTransparentImage(Buffer.alloc(40))).toBe(false);
  });
});

describe("validateSceneZip transparency rejection", () => {
  function sceneZip(image: Buffer) {
    return Buffer.from(
      zipSync({
        "Scene/image.jpg": new Uint8Array(image),
        "Scene/scenes.json": strToU8(JSON.stringify([{ id: "s1", nodes: [] }])),
        "Scene/template.json": strToU8(
          JSON.stringify({ image: "./image.jpg", name: "Scene" }),
        ),
      }),
    );
  }

  it("rejects a zip whose preview is proven fully transparent", () => {
    const result = validateSceneZip(sceneZip(transparentRgba(4, 4)));
    expect(result).toEqual({
      ok: false,
      error: "preview_image_fully_transparent",
    });
  });

  it("accepts a zip whose preview has visible pixels", () => {
    const rows = [new Array(4 * 4).fill(0)];
    rows[0]![3] = 255;
    const result = validateSceneZip(
      sceneZip(png({ filteredData: plainRows(rows), height: 1, width: 4 })),
    );
    expect(result.ok).toBe(true);
  });
});

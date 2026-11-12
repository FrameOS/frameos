// The panel's own bytes from a rendered scene (docs/server-rendering.md
// "Packing"): a port of the self-hosted backend's thin-client packer,
// pack_image_for_panel in backend/app/api/embedded_device.py, which the
// device blits without looking (fos_client.c fetch_remote_bitmap). Same
// formats, same palettes, same greys, same Floyd-Steinberg; the error
// diffusion is this file's own, so a picture packed here and one packed by
// the backend agree in kind, not byte for byte.
//
// Pure: RGBA in, packed bytes out, nothing allocated past the error rows.

/** `fos_pixel_format_t` (embedded/esp32/main/frameos_display.h). */
export const PanelPixelFormat = {
  oneBit: 1,
  dualOneBitRed: 2,
  dualOneBitYellow: 3,
  twoBitGray: 4,
  twoBitBwyr: 5,
  fourBitSevenColor: 6,
  fourBitSpectra6: 7,
  fourBitGray: 8,
  rgb565: 9,
} as const;

export type PanelPixelFormatCode = (typeof PanelPixelFormat)[keyof typeof PanelPixelFormat];

export function isPanelPixelFormat(value: unknown): value is PanelPixelFormatCode {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 9;
}

type Rgb = readonly [number, number, number];

// The colours each panel shows, by its wire index (embedded_device.py). A
// Spectra 6 panel has no colour at index 4: null there keeps the index out
// of the dither while the others keep their wire numbers.
export const bwyrPalette: readonly Rgb[] = [
  [57, 48, 57],
  [255, 255, 255],
  [208, 190, 71],
  [156, 72, 75],
];
export const spectra6Palette: readonly (Rgb | null)[] = [
  [25, 20, 38],
  [178, 193, 192],
  [199, 187, 0],
  [107, 17, 25],
  null,
  [24, 83, 154],
  [42, 85, 49],
];
export const sevenColorPalette: readonly Rgb[] = [
  [57, 48, 57],
  [255, 255, 255],
  [58, 91, 70],
  [61, 59, 94],
  [156, 72, 75],
  [208, 190, 71],
  [177, 106, 73],
];

/** Bytes the panel's buffer holds (embedded_buffer_size in embedded_firmware.py). */
export function panelBufferBytes(width: number, height: number, format: PanelPixelFormatCode): number {
  switch (format) {
    case PanelPixelFormat.oneBit:
      return Math.ceil(width / 8) * height;
    case PanelPixelFormat.dualOneBitRed:
    case PanelPixelFormat.dualOneBitYellow:
      return 2 * Math.ceil(width / 8) * height;
    case PanelPixelFormat.twoBitGray:
    case PanelPixelFormat.twoBitBwyr:
      return Math.ceil(width / 4) * height;
    case PanelPixelFormat.fourBitSevenColor:
    case PanelPixelFormat.fourBitSpectra6:
    case PanelPixelFormat.fourBitGray:
      return Math.ceil(width / 2) * height;
    case PanelPixelFormat.rgb565:
      return width * height * 2;
  }
}

/**
 * The canvas a scene draws on for a panel of `width` x `height` hung at
 * `rotate` degrees: the swapped one at 90 and 270, as on the device
 * (runner.nim, embedded_scene_dimensions).
 */
export function sceneCanvasSize(width: number, height: number, rotate: number): { height: number; width: number } {
  const turned = normalizedRotation(rotate) % 180 === 90;
  return turned ? { height: width, width: height } : { height, width };
}

function normalizedRotation(rotate: number): 0 | 90 | 180 | 270 {
  const value = (((Math.round(rotate) % 360) + 360) % 360) as number;
  return value === 90 || value === 180 || value === 270 ? value : 0;
}

/**
 * Turn a rendered RGBA picture clockwise by `rotate` (0/90/180/270) into the
 * panel's native orientation, as a frame with its own renderer does last
 * (rotateDegrees in frameos/utils/image.nim, rotate_for_panel).
 */
export function rotateRgbaClockwise(
  rgba: Uint8Array,
  width: number,
  height: number,
  rotate: number,
): { height: number; rgba: Uint8Array; width: number } {
  const turn = normalizedRotation(rotate);
  if (turn === 0) {
    return { height, rgba, width };
  }
  const outWidth = turn === 180 ? width : height;
  const outHeight = turn === 180 ? height : width;
  const out = new Uint8Array(rgba.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let dx: number;
      let dy: number;
      if (turn === 90) {
        dx = height - 1 - y;
        dy = x;
      } else if (turn === 180) {
        dx = width - 1 - x;
        dy = height - 1 - y;
      } else {
        dx = y;
        dy = width - 1 - x;
      }
      const from = (y * width + x) * 4;
      const to = (dy * outWidth + dx) * 4;
      out[to] = rgba[from]!;
      out[to + 1] = rgba[from + 1]!;
      out[to + 2] = rgba[from + 2]!;
      out[to + 3] = rgba[from + 3]!;
    }
  }
  return { height: outHeight, rgba: out, width: outWidth };
}

function clamp8(value: number): number {
  return value < 0 ? 0 : value > 255 ? 255 : value;
}

/**
 * One palette index per pixel, Floyd-Steinberg dithered (7/16 right, 3/16
 * below left, 5/16 below, 1/16 below right), nearest colour by squared RGB
 * distance. `channels` 1 reads the luma of each pixel against grey levels.
 */
function ditherIndices(
  source: Float32Array,
  width: number,
  height: number,
  channels: 1 | 3,
  palette: readonly (readonly number[])[],
): Uint8Array {
  const out = new Uint8Array(width * height);
  // Two rows of carried error: this one and the next.
  let current = new Float32Array((width + 2) * channels);
  let next = new Float32Array((width + 2) * channels);
  const value = new Float32Array(channels);
  for (let y = 0; y < height; y += 1) {
    next.fill(0);
    for (let x = 0; x < width; x += 1) {
      const base = (y * width + x) * channels;
      const errBase = (x + 1) * channels;
      for (let c = 0; c < channels; c += 1) {
        value[c] = clamp8(source[base + c]! + current[errBase + c]!);
      }
      let best = 0;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (let index = 0; index < palette.length; index += 1) {
        const entry = palette[index]!;
        let distance = 0;
        for (let c = 0; c < channels; c += 1) {
          const delta = value[c]! - entry[c]!;
          distance += delta * delta;
        }
        if (distance < bestDistance) {
          bestDistance = distance;
          best = index;
        }
      }
      out[y * width + x] = best;
      const chosen = palette[best]!;
      for (let c = 0; c < channels; c += 1) {
        const error = value[c]! - chosen[c]!;
        if (error === 0) continue;
        current[errBase + channels + c]! += (error * 7) / 16;
        next[errBase - channels + c]! += (error * 3) / 16;
        next[errBase + c]! += (error * 5) / 16;
        next[errBase + channels + c]! += error / 16;
      }
    }
    const swap = current;
    current = next;
    next = swap;
  }
  return out;
}

function rgbPlane(rgba: Uint8Array, width: number, height: number): Float32Array {
  const plane = new Float32Array(width * height * 3);
  for (let i = 0, j = 0; i < width * height; i += 1, j += 4) {
    plane[i * 3] = rgba[j]!;
    plane[i * 3 + 1] = rgba[j + 1]!;
    plane[i * 3 + 2] = rgba[j + 2]!;
  }
  return plane;
}

// The Nim renderer's toGrayscaleFloat weights (and the backend's).
function lumaPlane(rgba: Uint8Array, width: number, height: number): Float32Array {
  const plane = new Float32Array(width * height);
  for (let i = 0, j = 0; i < width * height; i += 1, j += 4) {
    plane[i] = Math.round(0.21 * rgba[j]! + 0.72 * rgba[j + 1]! + 0.07 * rgba[j + 2]!);
  }
  return plane;
}

function grayLevels(rgba: Uint8Array, width: number, height: number, levels: number): Uint8Array {
  const palette = Array.from({ length: levels }, (_, index) => [Math.round((index * 255) / (levels - 1))]);
  return ditherIndices(lumaPlane(rgba, width, height), width, height, 1, palette);
}

function packOneBit(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const row = Math.ceil(width / 8);
  const out = new Uint8Array(row * height);
  const levels = grayLevels(rgba, width, height, 2);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (levels[y * width + x]) {
        out[y * row + (x >> 3)]! |= 0x80 >> (x & 7);
      }
    }
  }
  return out;
}

function packDualOneBit(rgba: Uint8Array, width: number, height: number, accent: Rgb): Uint8Array {
  const row = Math.ceil(width / 8);
  const plane = row * height;
  // Black plane then colour plane, both white (set) until a pixel clears one.
  const out = new Uint8Array(plane * 2).fill(0xff);
  const indices = ditherIndices(rgbPlane(rgba, width, height), width, height, 3, [[0, 0, 0], accent, [255, 255, 255]]);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = indices[y * width + x]!;
      if (index > 1) continue;
      const offset = (index === 0 ? 0 : plane) + y * row + (x >> 3);
      out[offset]! &= ~(0x80 >> (x & 7)) & 0xff;
    }
  }
  return out;
}

function packTwoBitGray(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const row = Math.ceil(width / 4);
  const out = new Uint8Array(row * height);
  const levels = grayLevels(rgba, width, height, 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      out[y * row + (x >> 2)]! |= (levels[y * width + x]! & 0x03) << (6 - (x & 3) * 2);
    }
  }
  return out;
}

function packFourBitGray(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const row = Math.ceil(width / 2);
  const out = new Uint8Array(row * height);
  const levels = grayLevels(rgba, width, height, 16);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      out[y * row + (x >> 1)]! |= (levels[y * width + x]! & 0x0f) << ((x & 1) === 0 ? 4 : 0);
    }
  }
  return out;
}

function packPalette(
  rgba: Uint8Array,
  width: number,
  height: number,
  palette: readonly (Rgb | null)[],
  bits: 2 | 4,
): Uint8Array {
  // Dither against the colours the panel has, then write each pixel's wire
  // index (Spectra 6 skips 4).
  const entries = palette.flatMap((color, index) => (color ? [{ color, index }] : []));
  const indices = ditherIndices(
    rgbPlane(rgba, width, height),
    width,
    height,
    3,
    entries.map((entry) => entry.color),
  );
  const perByte = bits === 2 ? 4 : 2;
  const row = Math.ceil(width / perByte);
  const out = new Uint8Array(row * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const wire = entries[indices[y * width + x]!]!.index;
      if (bits === 2) {
        out[y * row + (x >> 2)]! |= (wire & 0x03) << (6 - (x & 3) * 2);
      } else {
        out[y * row + (x >> 1)]! |= (wire & 0x0f) << ((x & 1) === 0 ? 4 : 0);
      }
    }
  }
  return out;
}

function packRgb565(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height * 2);
  for (let i = 0, j = 0; i < width * height; i += 1, j += 4) {
    const word = ((rgba[j]! >> 3) << 11) | ((rgba[j + 1]! >> 2) << 5) | (rgba[j + 2]! >> 3);
    out[i * 2] = word & 0xff;
    out[i * 2 + 1] = word >> 8;
  }
  return out;
}

/** Pack an RGBA picture (alpha ignored, as the backend's RGB convert does) into the panel's format. */
export function packForPanel(
  rgba: Uint8Array,
  width: number,
  height: number,
  format: PanelPixelFormatCode,
): Uint8Array {
  if (rgba.length !== width * height * 4) {
    throw new Error(`packForPanel: ${rgba.length} bytes is not ${width}x${height} RGBA`);
  }
  switch (format) {
    case PanelPixelFormat.oneBit:
      return packOneBit(rgba, width, height);
    case PanelPixelFormat.dualOneBitRed:
      return packDualOneBit(rgba, width, height, [255, 0, 0]);
    case PanelPixelFormat.dualOneBitYellow:
      return packDualOneBit(rgba, width, height, [255, 255, 0]);
    case PanelPixelFormat.twoBitGray:
      return packTwoBitGray(rgba, width, height);
    case PanelPixelFormat.twoBitBwyr:
      return packPalette(rgba, width, height, bwyrPalette, 2);
    case PanelPixelFormat.fourBitSevenColor:
      return packPalette(rgba, width, height, sevenColorPalette, 4);
    case PanelPixelFormat.fourBitSpectra6:
      return packPalette(rgba, width, height, spectra6Palette, 4);
    case PanelPixelFormat.fourBitGray:
      return packFourBitGray(rgba, width, height);
    case PanelPixelFormat.rgb565:
      return packRgb565(rgba, width, height);
  }
}

export const fosbHeaderBytes = 12;

/** `FOSB`, version 1, format, width u16le, height u16le, reserved u16, then the packed bytes. */
export function fosbPayload(
  width: number,
  height: number,
  format: PanelPixelFormatCode,
  packed: Uint8Array,
): Buffer {
  const out = Buffer.alloc(fosbHeaderBytes + packed.length);
  out.write("FOSB", 0, "latin1");
  out.writeUInt8(1, 4);
  out.writeUInt8(format, 5);
  out.writeUInt16LE(width, 6);
  out.writeUInt16LE(height, 8);
  out.writeUInt16LE(0, 10);
  out.set(packed, fosbHeaderBytes);
  return out;
}

/**
 * The scene's RGBA, rendered on the canvas `sceneCanvasSize` gave, as the
 * FOSB a panel of `width` x `height` in `format` hung at `rotate` takes.
 */
export function panelFosb(
  rgba: Uint8Array,
  canvas: { height: number; width: number },
  panel: { format: PanelPixelFormatCode; height: number; rotate: number; width: number },
): Buffer {
  const turned = rotateRgbaClockwise(rgba, canvas.width, canvas.height, panel.rotate);
  if (turned.width !== panel.width || turned.height !== panel.height) {
    throw new Error(
      `panelFosb: a ${canvas.width}x${canvas.height} canvas at ${panel.rotate} degrees is not a ${panel.width}x${panel.height} panel`,
    );
  }
  return fosbPayload(panel.width, panel.height, panel.format, packForPanel(turned.rgba, turned.width, turned.height, panel.format));
}

// The panel's own bytes from a rendered scene (docs/server-rendering.md
// "Packing"): a port of the self-hosted backend's thin-client packer,
// pack_image_for_panel in backend/app/api/embedded_device.py, which the
// device blits without looking (fos_client.c fetch_remote_bitmap). Same
// formats, same palettes, same greys, same Floyd-Steinberg; the error
// diffusion is this file's own, so a picture packed here and one packed by
// the backend agree in kind, not byte for byte.
//
// Pure: RGBA in, packed bytes out, nothing allocated past the error rows.
//
// The palette is the device packer's (activePalette(framePalette(stock)) in
// frameos/src/embedded/embedded_main.nim): a photo's own dither palette, else
// the frame's `palette` colours, each fitted onto the table the way
// fitPaletteOverride (frameos/src/frameos/utils/dither.nim) fits it, else the
// stock table. `panelPalette` works it out; `packForPanel` and `panelFosb`
// take it.

/** `fos_pixel_format_t` (embedded/esp32/main/frameos_display.h), as `PanelPixelFormat` names them. */
export type PanelPixelFormatCode = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

type Rgb = readonly [number, number, number];

/** A panel's table by wire index; null is an index the panel has no colour for. */
export type PanelPalette = readonly (Rgb | null)[];

/**
 * The packer, whole: every table and function of this file, built by a call
 * of this one function. It is the ONE source, and it is self-contained on
 * purpose (no import, no variable from outside it, nothing of Node's: plain
 * typed arrays): the render worker gets its text (`panelPackerSource`) and
 * builds the same packer where the pixels are, so a pull's picture is
 * packed off the event loop (scene-render.ts). The exports below are this
 * function called once, so tests and the main thread's fallback run the
 * same code. panel-pack.test.ts builds the text in an empty `node:vm`
 * context and packs every format, rotation and palette both ways.
 */
export function createPanelPacker() {
  /** `fos_pixel_format_t` (embedded/esp32/main/frameos_display.h). */
  const PanelPixelFormat = {
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

  function isPanelPixelFormat(value: unknown): value is PanelPixelFormatCode {
    return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 9;
  }


  // The colours each panel shows, by its wire index (embedded_device.py, and
  // the Nim tables saturated4ColorPalette, saturated7ColorPalette and
  // spectra6ColorPalette in utils/dither.nim, which panel-pack.test.ts reads).
  // A Spectra 6 panel has no colour at index 4 (Nim's 999 placeholder): null
  // there keeps the index out of the dither while the others keep their wire
  // numbers.
  const bwyrPalette: readonly Rgb[] = [
    [57, 48, 57],
    [255, 255, 255],
    [208, 190, 71],
    [156, 72, 75],
  ];
  const spectra6Palette: readonly (Rgb | null)[] = [
    [25, 20, 38],
    [178, 193, 192],
    [199, 187, 0],
    [107, 17, 25],
    null,
    [24, 83, 154],
    [42, 85, 49],
  ];
  const sevenColorPalette: readonly Rgb[] = [
    [57, 48, 57],
    [255, 255, 255],
    [58, 91, 70],
    [61, 59, 94],
    [156, 72, 75],
    [208, 190, 71],
    [177, 106, 73],
  ];

  /** The stock table of a palette format; null for the grey, two-colour and RGB formats. */
  function stockPanelPalette(format: PanelPixelFormatCode): PanelPalette | null {
    switch (format) {
      case PanelPixelFormat.twoBitBwyr:
        return bwyrPalette;
      case PanelPixelFormat.fourBitSevenColor:
        return sevenColorPalette;
      case PanelPixelFormat.fourBitSpectra6:
        return spectra6Palette;
      default:
        return null;
    }
  }

  /**
   * `["#rrggbb", …]` as colours: frame.json's `palette.colors`, or the photo
   * palette a render reports. One unreadable colour empties the list, as the
   * device's parser does (fos_nim_set_palette_impl); anything that is not a
   * list is no list.
   */
  function readHexColors(value: unknown): Rgb[] {
    if (!Array.isArray(value)) {
      return [];
    }
    const out: Rgb[] = [];
    for (const entry of value) {
      const match = typeof entry === "string" ? /^#?([0-9a-f]{6})$/i.exec(entry.trim()) : null;
      if (!match) {
        return [];
      }
      const hex = Number.parseInt(match[1]!, 16);
      out.push([(hex >> 16) & 0xff, (hex >> 8) & 0xff, hex & 0xff]);
    }
    return out;
  }

  /**
   * `override` fitted onto `table` (fitPaletteOverride, utils/dither.nim): the
   * override when it names as many colours as the table; one fewer when the
   * table has its hole at index 4 (Spectra 6), the hole put back; the table
   * for any other length, an empty override included.
   */
  function fitPaletteOverride(override: readonly Rgb[], table: PanelPalette): PanelPalette {
    if (override.length === 0) {
      return table;
    }
    if (override.length === table.length) {
      return override;
    }
    if (table.length === override.length + 1 && table.length > 4 && table[4] === null) {
      return [...override.slice(0, 4), null, ...override.slice(4)];
    }
    return table;
  }

  /**
   * The table a panel of `format` is dithered to: the photo's palette (what
   * the render reports it drew last) fitted onto the frame's `palette` colours
   * fitted onto the stock table, as the device's packer does. Null for a
   * format without one.
   */
  function panelPalette(
    format: PanelPixelFormatCode,
    palettes: { frame?: unknown; photo?: unknown } = {},
  ): PanelPalette | null {
    const stock = stockPanelPalette(format);
    if (!stock) {
      return null;
    }
    return fitPaletteOverride(readHexColors(palettes.photo), fitPaletteOverride(readHexColors(palettes.frame), stock));
  }

  /** Bytes the panel's buffer holds (embedded_buffer_size in embedded_firmware.py). */
  function panelBufferBytes(width: number, height: number, format: PanelPixelFormatCode): number {
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
  function sceneCanvasSize(width: number, height: number, rotate: number): { height: number; width: number } {
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
  function rotateRgbaClockwise(
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
    palette: PanelPalette,
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

  /**
   * Pack an RGBA picture (alpha ignored, as the backend's RGB convert does)
   * into the panel's format. `palette` (panelPalette) replaces the stock table
   * of a palette format; the other formats ignore it.
   */
  function packForPanel(
    rgba: Uint8Array,
    width: number,
    height: number,
    format: PanelPixelFormatCode,
    palette?: PanelPalette | null,
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
        return packPalette(rgba, width, height, palette ?? bwyrPalette, 2);
      case PanelPixelFormat.fourBitSevenColor:
        return packPalette(rgba, width, height, palette ?? sevenColorPalette, 4);
      case PanelPixelFormat.fourBitSpectra6:
        return packPalette(rgba, width, height, palette ?? spectra6Palette, 4);
      case PanelPixelFormat.fourBitGray:
        return packFourBitGray(rgba, width, height);
      case PanelPixelFormat.rgb565:
        return packRgb565(rgba, width, height);
    }
  }

  const fosbHeaderBytes = 12;

  /** `FOSB`, version 1, format, width u16le, height u16le, reserved u16, then the packed bytes. */
  function fosbPayload(width: number, height: number, format: PanelPixelFormatCode, packed: Uint8Array): Uint8Array {
    const out = new Uint8Array(fosbHeaderBytes + packed.length);
    out.set([0x46, 0x4f, 0x53, 0x42, 1, format, width & 0xff, (width >> 8) & 0xff, height & 0xff, (height >> 8) & 0xff, 0, 0]);
    out.set(packed, fosbHeaderBytes);
    return out;
  }

  /**
   * The scene's RGBA, rendered on the canvas `sceneCanvasSize` gave, as the
   * FOSB a panel of `width` x `height` in `format` hung at `rotate` takes,
   * dithered to `palette` (panelPalette) where the format has one.
   */
  function panelFosb(
    rgba: Uint8Array,
    canvas: { height: number; width: number },
    panel: { format: PanelPixelFormatCode; height: number; rotate: number; width: number },
    palette?: PanelPalette | null,
  ): Uint8Array {
    const turned = rotateRgbaClockwise(rgba, canvas.width, canvas.height, panel.rotate);
    if (turned.width !== panel.width || turned.height !== panel.height) {
      throw new Error(
        `panelFosb: a ${canvas.width}x${canvas.height} canvas at ${panel.rotate} degrees is not a ${panel.width}x${panel.height} panel`,
      );
    }
    return fosbPayload(
      panel.width,
      panel.height,
      panel.format,
      packForPanel(turned.rgba, turned.width, turned.height, panel.format, palette),
    );
  }

  return {
    PanelPixelFormat,
    bwyrPalette,
    fitPaletteOverride,
    fosbHeaderBytes,
    fosbPayload,
    isPanelPixelFormat,
    packForPanel,
    panelBufferBytes,
    panelFosb,
    panelPalette,
    readHexColors,
    rotateRgbaClockwise,
    sceneCanvasSize,
    sevenColorPalette,
    spectra6Palette,
    stockPanelPalette,
  };
}

/** `createPanelPacker`'s text: what the render worker builds its packer from. */
export const panelPackerSource: string = String(createPanelPacker);

const packer = createPanelPacker();

export const PanelPixelFormat = packer.PanelPixelFormat;
export const bwyrPalette = packer.bwyrPalette;
export const sevenColorPalette = packer.sevenColorPalette;
export const spectra6Palette = packer.spectra6Palette;
export const fosbHeaderBytes = packer.fosbHeaderBytes;
export const isPanelPixelFormat = packer.isPanelPixelFormat;
export const stockPanelPalette = packer.stockPanelPalette;
export const readHexColors = packer.readHexColors;
export const fitPaletteOverride = packer.fitPaletteOverride;
export const panelPalette = packer.panelPalette;
export const panelBufferBytes = packer.panelBufferBytes;
export const sceneCanvasSize = packer.sceneCanvasSize;
export const rotateRgbaClockwise = packer.rotateRgbaClockwise;
export const packForPanel = packer.packForPanel;

function asBuffer(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** `FOSB`, version 1, format, width u16le, height u16le, reserved u16, then the packed bytes. */
export function fosbPayload(width: number, height: number, format: PanelPixelFormatCode, packed: Uint8Array): Buffer {
  return asBuffer(packer.fosbPayload(width, height, format, packed));
}

/**
 * The scene's RGBA, rendered on the canvas `sceneCanvasSize` gave, as the
 * FOSB a panel of `width` x `height` in `format` hung at `rotate` takes,
 * dithered to `palette` (panelPalette) where the format has one.
 */
export function panelFosb(
  rgba: Uint8Array,
  canvas: { height: number; width: number },
  panel: { format: PanelPixelFormatCode; height: number; rotate: number; width: number },
  palette?: PanelPalette | null,
): Buffer {
  return asBuffer(packer.panelFosb(rgba, canvas, panel, palette));
}

// A photo re-drawn at a chosen size (docs/photos.md "POST
// /api/photos/resize"): the backend's Pillow version lives in
// app/utils/photos.py resize_image_bytes; the two agree on the fits, the
// formats and the no-upscale rule. sharp loads on first use, like the
// thumbnailer; a host without it answers 503.

import type { Sharp } from "sharp";
import { logWarn } from "../log";
import { PhotoError } from "./library";
import { photoThumbMaxJpegPixels, photoThumbMaxPixels } from "./thumbnail";

export const resizeFits = ["inside", "cover", "contain", "fill"] as const;
export const resizeFormats = ["keep", "jpeg", "png", "webp"] as const;
export const resizeMaxSide = 16384;

export type ResizeFit = (typeof resizeFits)[number];
export type ResizeFormat = (typeof resizeFormats)[number];

export type ResizeOptions = {
  background: string;
  /** PNG only: a palette of this many colors (2 to 256), or every color. */
  colors: number | null;
  fit: ResizeFit;
  format: ResizeFormat;
  height: number | null;
  quality: number;
  upscale: boolean;
  width: number | null;
};

const extensions: Record<string, string> = {
  gif: ".gif",
  jpeg: ".jpg",
  png: ".png",
  webp: ".webp",
};

const contentTypes: Record<string, string> = {
  gif: "image/gif",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

/**
 * The request body as options, or the 400 it earns. Whole numbers only;
 * a fit other than `inside` needs both sides; a background is #rrggbb.
 */
export function parseResizeOptions(body: Record<string, unknown>): ResizeOptions {
  const whole = (value: unknown, name: string, min: number, max: number, required: boolean) => {
    if (value === undefined || value === null) {
      if (required) {
        throw new PhotoError("invalid_request", 400, { detail: `${name} is required` });
      }
      return null;
    }
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
      throw new PhotoError("invalid_request", 400, {
        detail: `${name} must be a whole number from ${min} to ${max}`,
      });
    }
    return value;
  };
  const width = whole(body.width, "width", 1, resizeMaxSide, false);
  const height = whole(body.height, "height", 1, resizeMaxSide, false);
  if (width === null && height === null) {
    throw new PhotoError("invalid_request", 400, { detail: "Give a width, a height, or both" });
  }
  const fit = body.fit === undefined ? "inside" : body.fit;
  if (!(resizeFits as readonly unknown[]).includes(fit)) {
    throw new PhotoError("invalid_request", 400, { detail: `fit must be one of ${resizeFits.join(", ")}` });
  }
  if (fit !== "inside" && (width === null || height === null)) {
    throw new PhotoError("invalid_request", 400, { detail: `fit ${String(fit)} needs both a width and a height` });
  }
  const format = body.format === undefined ? "keep" : body.format;
  if (!(resizeFormats as readonly unknown[]).includes(format)) {
    throw new PhotoError("invalid_request", 400, {
      detail: `format must be one of ${resizeFormats.join(", ")}`,
    });
  }
  const quality = whole(body.quality === undefined ? 85 : body.quality, "quality", 1, 100, true) as number;
  const colors = whole(body.colors, "colors", 2, 256, false);
  const upscale = body.upscale === undefined ? false : body.upscale;
  if (typeof upscale !== "boolean") {
    throw new PhotoError("invalid_request", 400, { detail: "upscale must be true or false" });
  }
  const background = body.background === undefined ? "#ffffff" : body.background;
  if (typeof background !== "string" || !/^#?[0-9a-fA-F]{6}$/.test(background.trim())) {
    throw new PhotoError("invalid_request", 400, { detail: "background must be a #rrggbb color" });
  }
  return {
    background: `#${background.trim().replace(/^#/, "")}`,
    colors,
    fit: fit as ResizeFit,
    format: format as ResizeFormat,
    height,
    quality,
    upscale,
    width,
  };
}

/**
 * The box the result is drawn on (the backend's resize_box): `inside` keeps
 * the aspect within the box, the other fits take the box as it is. Without
 * `upscale` nothing is invented: `inside` never grows the photo, and a box
 * larger than the photo shrinks to fit inside it at the box's own aspect.
 */
export function resizeBox(
  source: { height: number; width: number },
  options: Pick<ResizeOptions, "fit" | "height" | "upscale" | "width">,
): { height: number; width: number } {
  const { width: sw, height: sh } = source;
  if (options.fit === "inside") {
    const bw = options.width ?? sw;
    const bh = options.height ?? sh;
    let scale = Math.min(bw / sw, bh / sh);
    if (!options.upscale) {
      scale = Math.min(scale, 1);
    }
    return { height: Math.max(1, Math.round(sh * scale)), width: Math.max(1, Math.round(sw * scale)) };
  }
  let bw = options.width ?? sw;
  let bh = options.height ?? sh;
  if (!options.upscale && (bw > sw || bh > sh)) {
    const scale = Math.min(sw / bw, sh / bh);
    bw = Math.max(1, Math.round(bw * scale));
    bh = Math.max(1, Math.round(bh * scale));
  }
  return { height: bh, width: bw };
}

type SharpFactory = (input: Buffer, options: { failOn: "none"; limitInputPixels: number | boolean }) => Sharp;

let loading: Promise<SharpFactory | undefined> | undefined;

function loadSharp() {
  loading ??= import("sharp").then(
    ({ default: sharp }) => {
      sharp.cache(false);
      return sharp;
    },
    (error: unknown) => {
      logWarn("photos.resizer_unavailable", { error: String(error) });
      return undefined;
    },
  );
  return loading;
}

export type ResizedPhoto = {
  bytes: Buffer;
  contentType: string;
  extension: string;
  height: number;
  width: number;
};

/**
 * The photo re-drawn as `options` asks, upright (its EXIF turn applied and
 * dropped), in the format asked for or the one it came in. 400 for a file
 * sharp cannot read or a format it cannot write, 413 over the pixel cap,
 * 503 without sharp.
 */
export async function resizePhotoBytes(input: Buffer, options: ResizeOptions): Promise<ResizedPhoto> {
  const sharp = await loadSharp();
  if (!sharp) {
    throw new PhotoError("resize_unavailable", 503);
  }
  const meta = await sharp(input, { failOn: "none", limitInputPixels: false }).metadata();
  const sourceFormat = meta.format ?? "";
  const pixels = (meta.width ?? 0) * (meta.height ?? 0);
  if (!meta.width || !meta.height) {
    throw new PhotoError("not_an_image", 400);
  }
  if (pixels > (sourceFormat === "jpeg" ? photoThumbMaxJpegPixels : photoThumbMaxPixels)) {
    throw new PhotoError("too_large", 413);
  }
  const targetFormat = options.format === "keep" ? sourceFormat : options.format;
  if (!(targetFormat in extensions)) {
    throw new PhotoError("unsupported_format", 400, { detail: `Images of type ${sourceFormat || "unknown"} cannot be resized here` });
  }
  // The box is measured against the photo as it is seen: turned by its EXIF.
  const turned = [5, 6, 7, 8].includes(meta.orientation ?? 1);
  const source = turned ? { height: meta.width, width: meta.height } : { height: meta.height, width: meta.width };
  const box = resizeBox(source, options);
  let image = sharp(input, { failOn: "none", limitInputPixels: false }).rotate();
  if (options.fit === "inside" || options.fit === "fill") {
    image = image.resize(box.width, box.height, { fit: "fill" });
  } else if (options.fit === "cover") {
    image = image.resize(box.width, box.height, { fit: "cover", position: "centre" });
  } else {
    image = image.resize(box.width, box.height, { background: options.background, fit: "contain", position: "centre" });
  }
  if (targetFormat === "jpeg") {
    // Baseline, never progressive: the smallest frames decode a baseline JPEG in strips.
    image = image.flatten({ background: options.background }).jpeg({ progressive: false, quality: options.quality });
  } else if (targetFormat === "png") {
    image = options.colors ? image.png({ colors: options.colors, palette: true }) : image.png();
  } else if (targetFormat === "webp") {
    image = image.webp({ lossless: options.quality >= 100, quality: options.quality });
  } else {
    image = image.gif();
  }
  const { data, info } = await image.toBuffer({ resolveWithObject: true });
  return {
    bytes: data,
    contentType: contentTypes[targetFormat]!,
    extension: extensions[targetFormat]!,
    height: info.height,
    width: info.width,
  };
}

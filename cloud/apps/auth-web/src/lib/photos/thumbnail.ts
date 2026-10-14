// A photo's thumbnail, made when the photo is stored, whoever sent it (the
// SPA, the MCP's photo_upload, a script with an API token). It is what the
// backend's Pillow makes (backend/app/utils/photos.py `thumbnail`): at most
// 512 px on the long side, turned by its EXIF orientation, transparency on
// white, JPEG at quality 82. It is made from bytes that already passed every
// scanner, so it is not scanned again.
//
// sharp (libvips) loads on first use. A file it cannot read, or a host
// without its native binary, means no thumbnail and nothing worse: the photo
// is stored, GET /api/photos/thumb answers 404 and the SPA shows the photo
// itself.

import type { Sharp } from "sharp";
import { logWarn } from "../log";

export const photoThumbMaxSide = 512;
// A PNG, GIF or WebP decodes to width x height x 4 bytes whatever its file
// size: 20 MiB of PNG can already be 16k x 16k, a gigabyte of pixels. Above
// this the photo is stored without a thumbnail (sharp's default allows
// 268 MP). A JPEG is different: libjpeg shrinks it while decoding, so a
// camera's 100 MP file costs a fraction of that, and the cap is higher.
export const photoThumbMaxPixels = 80_000_000;
export const photoThumbMaxJpegPixels = 400_000_000;

/** A photo as bytes in memory, or as a file on disk (a finished chunked upload). */
export type PhotoImageInput = Buffer | string;

type SharpFactory = (
  input: PhotoImageInput,
  options: { failOn: "none"; limitInputPixels: number | boolean },
) => Sharp;

let loading: Promise<SharpFactory | undefined> | undefined;

function loadSharp() {
  loading ??= import("sharp").then(
    ({ default: sharp }) => {
      // Every photo is new to libvips' cache: holding its decoded pixels
      // helps no later request.
      sharp.cache(false);
      return sharp;
    },
    (error: unknown) => {
      logWarn("photos.thumbnailer_unavailable", { error: String(error) });
      return undefined;
    },
  );
  return loading;
}

/**
 * The image opened for a resize, or a throw when it is over the cap for its
 * format. The header is read first (cheap), so a giant PNG is refused
 * before a decode could start.
 */
async function openPhoto(sharp: SharpFactory, input: PhotoImageInput): Promise<Sharp> {
  const meta = await sharp(input, { failOn: "none", limitInputPixels: false }).metadata();
  const pixels = (meta.width ?? 0) * (meta.height ?? 0);
  const cap = meta.format === "jpeg" ? photoThumbMaxJpegPixels : photoThumbMaxPixels;
  if (pixels > cap) {
    throw new Error(`Input image exceeds pixel limit: ${pixels} > ${cap} (${meta.format ?? "unknown"})`);
  }
  return sharp(input, { failOn: "none", limitInputPixels: cap });
}

/**
 * The copy PhotoDNA scans: a JPEG of at most 2048 px, well under the Match
 * API's size limit whatever the upload was (a 250 MiB JPEG, a WebP it does
 * not read). PhotoDNA is a perceptual hash: a resized copy matches what the
 * original would. Null when sharp cannot read the image.
 */
export async function photoScanCopy(input: PhotoImageInput): Promise<Buffer | null> {
  const sharp = await loadSharp();
  if (!sharp) {
    return null;
  }
  try {
    return await (await openPhoto(sharp, input))
      .rotate()
      .resize(2048, 2048, { fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 85 })
      .toBuffer();
  } catch (error) {
    logWarn("photos.scan_copy_failed", { error: String(error) });
    return null;
  }
}

/** A JPEG thumbnail of an image, or null when there cannot be one. */
export async function makePhotoThumbnail(input: PhotoImageInput): Promise<Buffer | null> {
  const sharp = await loadSharp();
  if (!sharp) {
    return null;
  }
  try {
    // failOn "none": a truncated file still gets the thumbnail a browser
    // would draw of it. GIFs give their first frame.
    return await (await openPhoto(sharp, input))
      .rotate()
      .resize(photoThumbMaxSide, photoThumbMaxSide, { fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 82 })
      .toBuffer();
  } catch (error) {
    logWarn("photos.thumbnail_failed", { error: String(error) });
    return null;
  }
}

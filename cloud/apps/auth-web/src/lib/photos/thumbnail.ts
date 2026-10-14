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
// A PNG decodes to width x height x 4 bytes whatever its file size: 20 MiB
// of PNG can be 16k x 16k, a gigabyte of pixels. Above this the photo is
// stored without a thumbnail (sharp's default allows 268 MP).
export const photoThumbMaxPixels = 80_000_000;

type SharpFactory = (input: Buffer, options: { failOn: "none"; limitInputPixels: number }) => Sharp;

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
 * The copy PhotoDNA scans: a JPEG of at most 2048 px, well under the Match
 * API's size limit whatever the upload was (a 20 MiB PNG, a WebP it does
 * not read). PhotoDNA is a perceptual hash: a resized copy matches what the
 * original would. Null when sharp cannot read the image.
 */
export async function photoScanCopy(bytes: Buffer): Promise<Buffer | null> {
  const sharp = await loadSharp();
  if (!sharp) {
    return null;
  }
  try {
    return await sharp(bytes, { failOn: "none", limitInputPixels: photoThumbMaxPixels })
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
export async function makePhotoThumbnail(bytes: Buffer): Promise<Buffer | null> {
  const sharp = await loadSharp();
  if (!sharp) {
    return null;
  }
  try {
    // failOn "none": a truncated file still gets the thumbnail a browser
    // would draw of it. GIFs give their first frame.
    return await sharp(bytes, { failOn: "none", limitInputPixels: photoThumbMaxPixels })
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

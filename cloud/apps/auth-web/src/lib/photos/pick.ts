// Which photo a frame shows (docs/photos.md, GET /api/photos/shared/{token}/
// photo). The frame keeps a counter, `index`; the photo is the one at
// `index mod count` in the chosen order. For `random` the order is a shuffle
// seeded by the token and the cycle number (floor(index / count)), so every
// photo shows once before any repeats and each cycle has a new order. The
// backend shuffles differently; the contract does not ask the two to agree.

import { createHash } from "node:crypto";
import { comparePhotoPaths } from "./paths";

export const photoOrders = ["random", "sequential", "newest", "oldest"] as const;
export type PhotoOrder = (typeof photoOrders)[number];

export function parsePhotoOrder(value: string | null | undefined): PhotoOrder | undefined {
  if (value === null || value === undefined || value === "") {
    return "random";
  }
  return (photoOrders as readonly string[]).includes(value) ? (value as PhotoOrder) : undefined;
}

/** A 32-bit seed from any string (the first four bytes of its SHA-256). */
export function seedFromString(value: string): number {
  return createHash("sha256").update(value).digest().readUInt32BE(0);
}

// mulberry32: small, fast and good enough to shuffle a photo album. Returns
// floats in [0, 1).
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates with a seeded generator. Never modifies `items`. */
export function seededShuffle<T>(items: readonly T[], seed: string): T[] {
  const result = [...items];
  const random = mulberry32(seedFromString(seed));
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    const swap = result[index] as T;
    result[index] = result[other] as T;
    result[other] = swap;
  }
  return result;
}

export const photoShapes = ["landscape", "portrait", "square"] as const;
export type PhotoShape = (typeof photoShapes)[number];

/** landscape, portrait or square by the photo's pixels; null when its size is not known. */
export function photoShape(width: number | null | undefined, height: number | null | undefined): PhotoShape | null {
  if (!width || !height) {
    return null;
  }
  return width > height ? "landscape" : height > width ? "portrait" : "square";
}

/**
 * `shapes=landscape,square` on the share routes and `shapes` in a scene
 * body: the shapes to play, in `photoShapes` order and without repeats.
 * null for every shape (an empty value, or all of them named); undefined
 * for a name that is not a shape.
 */
export function parsePhotoShapes(value: string | readonly string[] | null | undefined): PhotoShape[] | null | undefined {
  const names = (Array.isArray(value) ? value : String(value ?? "").split(","))
    .map((name) => String(name).trim())
    .filter(Boolean);
  if (names.some((name) => !(photoShapes as readonly string[]).includes(name))) {
    return undefined;
  }
  const chosen = photoShapes.filter((shape) => names.includes(shape));
  return chosen.length === 0 || chosen.length === photoShapes.length ? null : chosen;
}

/**
 * The photos of the chosen shapes. With every shape (null) nothing is
 * dropped, a photo of unknown size included; with a choice, only photos
 * whose size is known and fits.
 */
export function filterPhotoShapes<T extends { height: number | null; width: number | null }>(
  photos: readonly T[],
  shapes: readonly PhotoShape[] | null,
): T[] {
  if (!shapes) {
    return [...photos];
  }
  return photos.filter((photo) => {
    const shape = photoShape(photo.width, photo.height);
    return shape !== null && shapes.includes(shape);
  });
}

export type OrderablePhoto = { mtime: number; path: string };

/** The album in `order`, before any shuffle: by path, or by mtime then path. */
export function sortPhotos<T extends OrderablePhoto>(
  photos: readonly T[],
  order: Exclude<PhotoOrder, "random">,
): T[] {
  const sorted = [...photos];
  if (order === "sequential") {
    return sorted.sort((a, b) => comparePhotoPaths(a.path, b.path));
  }
  const direction = order === "newest" ? -1 : 1;
  return sorted.sort(
    (a, b) => direction * (a.mtime - b.mtime) || comparePhotoPaths(a.path, b.path),
  );
}

/**
 * The photo at `index` in `order`. `photos` may be in any order; the random
 * order shuffles the sequential one so the result does not depend on how the
 * caller happened to list them.
 */
export function pickPhoto<T extends OrderablePhoto>(
  photos: readonly T[],
  options: { index: number; order: PhotoOrder; token: string },
): { count: number; index: number; photo: T | null } {
  const count = photos.length;
  if (count === 0) {
    return { count: 0, index: options.index, photo: null };
  }
  const position = ((options.index % count) + count) % count;
  let ordered: T[];
  if (options.order === "random") {
    const cycle = Math.floor(options.index / count);
    ordered = seededShuffle(sortPhotos(photos, "sequential"), `${options.token}:${cycle}`);
  } else {
    ordered = sortPhotos(photos, options.order);
  }
  return { count, index: options.index, photo: ordered[position] ?? null };
}

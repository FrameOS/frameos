// Photo library paths (docs/photos.md "Paths"). Every path is relative to the
// library root: `/`-separated, no leading or trailing `/`, the root is "".
// The rules are the contract both control planes enforce, so a path that one
// accepts the other accepts too; a path that breaks them is a 400.

export const maxPhotoSegmentBytes = 255;
export const maxPhotoPathBytes = 1024;
export const maxPhotoPathDepth = 32;

// Frames decode these, by extension (docs/photos.md "Share routes").
export const playablePhotoExtensions = [
  "bmp",
  "gif",
  "jpeg",
  "jpg",
  "png",
  "ppm",
  "qoi",
  "webp",
] as const;

function byteLength(value: string) {
  return Buffer.byteLength(value, "utf8");
}

// A lone surrogate survives JSON.parse but has no UTF-8 encoding: the
// round trip turns it into U+FFFD, so the stored name would differ from the
// one the client sent.
function isWellFormedUtf16(value: string) {
  return Buffer.from(value, "utf8").toString("utf8") === value;
}

/** One name: 1-255 bytes, not hidden, no separators or control characters. */
export function isValidPhotoSegment(segment: string): boolean {
  if (segment.length === 0 || byteLength(segment) > maxPhotoSegmentBytes) {
    return false;
  }
  if (segment.startsWith(".")) {
    // Also covers "." and "..".
    return false;
  }
  if (!isWellFormedUtf16(segment)) {
    return false;
  }
  for (let index = 0; index < segment.length; index += 1) {
    const code = segment.charCodeAt(index);
    if (code < 0x20 || code === 0x7f || code === 0x2f || code === 0x5c) {
      return false;
    }
  }
  return true;
}

/**
 * The path when it follows the rules, else undefined. `allowRoot` decides
 * whether "" (the library root) is acceptable for this parameter.
 */
export function parsePhotoPath(
  raw: unknown,
  options: { allowRoot: boolean },
): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  if (raw === "") {
    return options.allowRoot ? "" : undefined;
  }
  if (byteLength(raw) > maxPhotoPathBytes) {
    return undefined;
  }
  const segments = raw.split("/");
  if (segments.length > maxPhotoPathDepth) {
    return undefined;
  }
  return segments.every(isValidPhotoSegment) ? raw : undefined;
}

// One move or delete takes at most this many paths (a selection, not a
// library).
export const maxPhotoPathsPerRequest = 1000;

/** A non-empty list of valid, non-root paths, or undefined. */
export function parsePhotoPathList(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > maxPhotoPathsPerRequest) {
    return undefined;
  }
  const paths: string[] = [];
  for (const item of value) {
    const path = parsePhotoPath(item, { allowRoot: false });
    if (path === undefined) {
      return undefined;
    }
    paths.push(path);
  }
  return paths;
}

/** True when a path of this length and depth is still within the limits. */
export function photoPathWithinLimits(path: string): boolean {
  return (
    path === "" ||
    (byteLength(path) <= maxPhotoPathBytes && photoPathDepth(path) <= maxPhotoPathDepth)
  );
}

export function photoPathDepth(path: string): number {
  return path === "" ? 0 : path.split("/").length;
}

export function photoParent(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

export function photoBasename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function joinPhotoPath(parent: string, name: string): string {
  return parent === "" ? name : `${parent}/${name}`;
}

/** `path` is `ancestor` itself or somewhere below it. The root contains all. */
export function isSameOrBelow(path: string, ancestor: string): boolean {
  return ancestor === "" || path === ancestor || path.startsWith(`${ancestor}/`);
}

/** Every folder from the top down to `path` itself: "a/b/c" -> a, a/b, a/b/c. */
export function photoPathPrefixes(path: string): string[] {
  if (path === "") {
    return [];
  }
  const segments = path.split("/");
  return segments.map((_, index) => segments.slice(0, index + 1).join("/"));
}

function splitExtension(name: string): { extension: string; stem: string } {
  const dot = name.lastIndexOf(".");
  // A leading dot is not an extension (hidden names are refused anyway).
  if (dot <= 0) {
    return { extension: "", stem: name };
  }
  return { extension: name.slice(dot), stem: name.slice(0, dot) };
}

// Trim a string to at most `maxBytes` of UTF-8 without cutting a character
// (or a surrogate pair) in half.
function truncateToBytes(value: string, maxBytes: number): string {
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const size = byteLength(character);
    if (bytes + size > maxBytes) {
      break;
    }
    result += character;
    bytes += size;
  }
  return result;
}

/**
 * The name a duplicate gets: `beach.jpg` -> `beach (2).jpg`, a folder
 * `Summer` -> `Summer (2)`. Stays within the segment limit by shortening the
 * stem.
 */
export function photoNameWithSuffix(name: string, counter: number): string {
  const { extension, stem } = splitExtension(name);
  const suffix = ` (${counter})`;
  const room = maxPhotoSegmentBytes - byteLength(suffix) - byteLength(extension);
  if (room <= 0) {
    // An extension so long there is no room left: suffix the whole name.
    return `${truncateToBytes(name, maxPhotoSegmentBytes - byteLength(suffix))}${suffix}`;
  }
  return `${truncateToBytes(stem, room)}${suffix}${extension}`;
}

export function isPlayablePhotoName(name: string): boolean {
  const { extension } = splitExtension(name);
  const lowered = extension.slice(1).toLowerCase();
  return (playablePhotoExtensions as readonly string[]).includes(lowered);
}

// Natural order, case insensitive: "IMG 2" < "img 10" < "IMG 11". Chunks of
// digits compare by value (leading zeros only break ties), everything else by
// lower-cased code points. The last tie-break is the plain comparison, so the
// order is total and two names that differ only in case keep a fixed order.
const chunkPattern = /(\d+)|(\D+)/g;

function chunks(value: string): string[] {
  return value.match(chunkPattern) ?? [];
}

function isDigits(value: string) {
  const code = value.charCodeAt(0);
  return code >= 0x30 && code <= 0x39;
}

function compareCodePoints(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareDigitChunks(a: string, b: string): number {
  const trimmedA = a.replace(/^0+(?=\d)/, "");
  const trimmedB = b.replace(/^0+(?=\d)/, "");
  if (trimmedA.length !== trimmedB.length) {
    return trimmedA.length - trimmedB.length;
  }
  return compareCodePoints(trimmedA, trimmedB);
}

export function comparePhotoNames(a: string, b: string): number {
  const left = chunks(a);
  const right = chunks(b);
  const count = Math.min(left.length, right.length);
  for (let index = 0; index < count; index += 1) {
    const chunkA = left[index] as string;
    const chunkB = right[index] as string;
    const digitsA = isDigits(chunkA);
    const digitsB = isDigits(chunkB);
    let result: number;
    if (digitsA && digitsB) {
      result = compareDigitChunks(chunkA, chunkB);
    } else if (digitsA !== digitsB) {
      // A number sorts before text at the same position.
      result = digitsA ? -1 : 1;
    } else {
      result = compareCodePoints(chunkA.toLowerCase(), chunkB.toLowerCase());
    }
    if (result !== 0) {
      return result;
    }
  }
  if (left.length !== right.length) {
    return left.length - right.length;
  }
  // Equal up to case and leading zeros: fewer leading zeros, then code points.
  const lengthDifference = a.length - b.length;
  if (lengthDifference !== 0) {
    return lengthDifference;
  }
  return compareCodePoints(a, b);
}

/** Paths in natural order, one segment at a time (a folder before its contents). */
export function comparePhotoPaths(a: string, b: string): number {
  const left = a.split("/");
  const right = b.split("/");
  const count = Math.min(left.length, right.length);
  for (let index = 0; index < count; index += 1) {
    const result = comparePhotoNames(left[index] as string, right[index] as string);
    if (result !== 0) {
      return result;
    }
  }
  return left.length - right.length;
}

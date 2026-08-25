import { randomBytes } from "node:crypto";
import { strToU8, unzipSync, unzlibSync, zipSync } from "fflate";

// FrameOS store constants and helpers (STORE-TODO). Payloads are the frameos
// template interchange zip: {name}/template.json + scenes.json + image.jpg.

export const storePublishScope = "store:publish";

export const maxSceneZipBytes = 8 * 1024 * 1024;
export const maxSceneZipUncompressedBytes = 32 * 1024 * 1024;
export const maxSceneZipEntries = 200;
export const maxPreviewImageBytes = 4 * 1024 * 1024;
export const maxImagesPerScene = 10;
export const maxScenesPerAccount = 200;
// The byte quota moved to src/lib/usage.ts (maxPrivateSceneBytesPerAccount,
// 200 MiB, private scenes only — public scenes are free).
// Versions are immutable, but they are Postgres blobs: keep the newest 20 per
// scene and prune older ones on publish (documented deviation, STORE-TODO).
export const maxVersionsPerScene = 20;

// Abuse limits for a public registry: per-account, on
// top of the per-IP limits in rate-limit.ts.
export const maxPublishesPerHour = 30;
// Editor saves are expected to be much more frequent than uploads or linked
// backend publishes while someone experiments with a scene. They use their
// own buckets so active editing cannot exhaust the stricter publish limit.
export const maxSceneEditsPer15Minutes = 120;
export const maxSceneEditsPerHour = 200;
export const maxNewScenesPerDay = 20;
export const maxReportsPerDay = 10;
export const maxReportReasonLength = 1000;

export const sceneVisibilities = new Set(["private", "public"]);

// The "what changed" note a save can carry. One line, so the version
// dropdown and the Versions table can show it whole; long enough for a
// sentence, short enough that nobody writes release notes in it.
export const maxVersionMessageLength = 200;

// Normalizes a user-supplied version message: a single trimmed line, capped.
// Returns null for anything empty or not a string — no message is a normal
// state, not an error.
export function normalizeVersionMessage(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const message = value.replace(/\s+/g, " ").trim();
  return message ? message.slice(0, maxVersionMessageLength) : null;
}

// Publisher-assigned tags: short lowercase slugs for browsing/filtering.
export const maxTagsPerScene = 5;
const tagPattern = /^[a-z0-9][a-z0-9-]{0,23}$/;

// Normalizes a user-supplied tag list (lowercase, trimmed, deduplicated).
// Returns undefined when the input is not a valid tag list.
export function normalizeTags(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > maxTagsPerScene) {
    return undefined;
  }
  const tags: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string") {
      return undefined;
    }
    const tag = raw.trim().toLowerCase();
    if (!tagPattern.test(tag)) {
      return undefined;
    }
    if (!tags.includes(tag)) {
      tags.push(tag);
    }
  }
  return tags;
}

// Lenient counterpart to normalizeTags for machine-suggested tags (the
// publish classifier): slugify each candidate, drop what still doesn't fit,
// keep at most maxTagsPerScene. Never fails — bad suggestions just vanish.
export function sanitizeTagCandidates(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const tags: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string") {
      continue;
    }
    const tag = raw
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24);
    if (tagPattern.test(tag) && !tags.includes(tag)) {
      tags.push(tag);
    }
    if (tags.length >= maxTagsPerScene) {
      break;
    }
  }
  return tags;
}

// Risk flags computed from the scenes JSON at publish. "shell" marks scenes
// that can run commands on the frame: apps known to shell out
// (data/chromiumScreenshot, data/rstpSnapshot run /bin/sh -c) or custom code
// nodes calling Nim process APIs. This is a warning badge, not a sandbox —
// code nodes are arbitrary Nim compiled onto the device, so absence of the
// flag is no guarantee (documented in STORE-TODO threat model).
export const riskFlagShell = "shell";

const shellAppKeywordPattern =
  /(shell|exec|terminal|command|chromiumscreenshot|rstpsnapshot)/i;
const shellCodePattern =
  /\b(execShellCmd|execCmdEx|execCmd|execProcess|startProcess|runShellWithParentStreams|runShellCapture|osproc|quoteShell|child_process)\b/;

export function detectRiskFlags(scenes: unknown): string[] {
  const flags = new Set<string>();
  if (!Array.isArray(scenes)) {
    return [];
  }
  for (const scene of scenes) {
    const nodes = (scene as { nodes?: unknown } | null)?.nodes;
    if (Array.isArray(nodes)) {
      for (const node of nodes) {
        const data = (node as { data?: unknown } | null)?.data;
        const keyword = (data as { keyword?: unknown } | null)?.keyword;
        if (
          typeof keyword === "string" &&
          shellAppKeywordPattern.test(keyword)
        ) {
          flags.add(riskFlagShell);
        }
      }
    }
    // Full-text sweep catches shell APIs in code nodes, edited app sources,
    // and config values, wherever they hide in the node graph.
    if (shellCodePattern.test(JSON.stringify(scene))) {
      flags.add(riskFlagShell);
    }
  }
  return [...flags].sort();
}

// The app keywords configured in a scene's node graph (e.g. "data/openWeather",
// "render/text"). The strongest signal the publish classifier has about what
// a scene actually does, since names and descriptions are often terse.
export function extractAppKeywords(scenes: unknown): string[] {
  const keywords = new Set<string>();
  if (!Array.isArray(scenes)) {
    return [];
  }
  for (const scene of scenes) {
    const nodes = (scene as { nodes?: unknown } | null)?.nodes;
    if (!Array.isArray(nodes)) {
      continue;
    }
    for (const node of nodes) {
      const data = (node as { data?: unknown } | null)?.data;
      const keyword = (data as { keyword?: unknown } | null)?.keyword;
      if (typeof keyword === "string" && keyword.trim()) {
        keywords.add(keyword.trim().slice(0, 64));
      }
    }
  }
  return [...keywords].sort().slice(0, 40);
}

// Sniff the real image format from the bytes (gallery uploads are served
// back with a fixed content type, never the uploader's choosing). Returns
// undefined for anything that is not a plain raster image.
export function detectImageContentType(content: Buffer): string | undefined {
  if (content.length < 12) {
    return undefined;
  }
  if (content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff) {
    return "image/jpeg";
  }
  if (content.subarray(0, 8).equals(Buffer.from("\x89PNG\r\n\x1a\n", "latin1"))) {
    return "image/png";
  }
  if (
    content.subarray(0, 4).toString("latin1") === "RIFF" &&
    content.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return "image/webp";
  }
  const gifHeader = content.subarray(0, 6).toString("latin1");
  if (gifHeader === "GIF87a" || gifHeader === "GIF89a") {
    return "image/gif";
  }
  return undefined;
}

// Proves, from the bytes alone, that an image is fully transparent — every
// pixel's alpha is zero, i.e. the fingerprint of a live-preview screenshot
// captured before the wasm runtime painted its first frame. Only PNG can be
// proven without an image library: JPEG/GIF have no alpha channel, and WebP
// alpha cannot be checked without a full decoder. Anything that is not a
// provably-blank PNG is accepted (returns false); a REJECT here must be a
// mathematical certainty, never a heuristic:
// - color types 0/2 (grey/RGB) and palette without tRNS have no alpha.
// - 8-bit non-interlaced grey+alpha/RGBA: inflate the IDAT stream, undo the
//   five scanline filters (filtered deltas can encode nonzero alpha, so raw
//   scanning is not sound), and scan every alpha byte.
// - 16-bit, Adam7-interlaced, palette+tRNS, oversized (> 64 MB of raw pixel
//   data), or malformed/truncated input: cannot cheaply prove, so accept.
export function isProvablyFullyTransparentImage(content: Uint8Array): boolean {
  const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (content.length < 8 + 25 || pngSignature.some((byte, i) => content[i] !== byte)) {
    return false;
  }

  // Walk the chunk list: IHDR must come first; collect IDAT and note tRNS.
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let sawIhdr = false;
  let sawTrns = false;
  const idatChunks: Uint8Array[] = [];
  let idatBytes = 0;
  let offset = 8;
  while (offset + 8 <= content.length) {
    const length =
      (content[offset]! << 24) |
      (content[offset + 1]! << 16) |
      (content[offset + 2]! << 8) |
      content[offset + 3]!;
    if (length < 0 || offset + 12 + length > content.length) {
      return false; // Truncated or absurd chunk: cannot prove anything.
    }
    const type = String.fromCharCode(
      content[offset + 4]!,
      content[offset + 5]!,
      content[offset + 6]!,
      content[offset + 7]!,
    );
    const data = content.subarray(offset + 8, offset + 8 + length);
    if (!sawIhdr) {
      if (type !== "IHDR" || length !== 13) {
        return false;
      }
      width = (data[0]! << 24) | (data[1]! << 16) | (data[2]! << 8) | data[3]!;
      height = (data[4]! << 24) | (data[5]! << 16) | (data[6]! << 8) | data[7]!;
      bitDepth = data[8]!;
      colorType = data[9]!;
      interlace = data[12]!;
      sawIhdr = true;
    } else if (type === "tRNS") {
      sawTrns = true;
    } else if (type === "IDAT") {
      idatChunks.push(data);
      idatBytes += data.length;
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  if (!sawIhdr || idatChunks.length === 0 || width <= 0 || height <= 0) {
    return false;
  }

  // No alpha anywhere in these color modes: opaque by definition. Palette
  // WITH a tRNS chunk could in principle be all-transparent, but proving it
  // needs a palette-aware pixel scan — out of scope, accept.
  if (colorType === 0 || colorType === 2 || colorType === 3) {
    return false;
  }
  // Only plain 8-bit grey+alpha (4) and RGBA (6) are provable here.
  if ((colorType !== 4 && colorType !== 6) || bitDepth !== 8 || interlace !== 0 || sawTrns) {
    return false;
  }

  const channels = colorType === 4 ? 2 : 4;
  const stride = width * channels;
  const rawSize = height * (1 + stride);
  if (rawSize > 64 * 1024 * 1024) {
    return false; // Scanning would cost too much: accept rather than prove.
  }

  let raw: Uint8Array;
  try {
    const compressed = new Uint8Array(idatBytes);
    let idatOffset = 0;
    for (const chunk of idatChunks) {
      compressed.set(chunk, idatOffset);
      idatOffset += chunk.length;
    }
    raw = unzlibSync(compressed);
  } catch {
    return false;
  }
  if (raw.length < rawSize) {
    return false;
  }

  // Undo the per-scanline filters (spec section 9): each byte may reference
  // the left/up/up-left reconstructed bytes, so alpha can only be judged on
  // the reconstructed scanlines.
  const previous = new Uint8Array(stride);
  const line = new Uint8Array(stride);
  let position = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[position]!;
    position += 1;
    for (let x = 0; x < stride; x++) {
      const value = raw[position + x]!;
      const left = x >= channels ? line[x - channels]! : 0;
      const up = previous[x]!;
      const upLeft = x >= channels ? previous[x - channels]! : 0;
      let reconstructed: number;
      switch (filter) {
        case 0:
          reconstructed = value;
          break;
        case 1:
          reconstructed = value + left;
          break;
        case 2:
          reconstructed = value + up;
          break;
        case 3:
          reconstructed = value + ((left + up) >> 1);
          break;
        case 4:
          reconstructed = value + paethPredictor(left, up, upLeft);
          break;
        default:
          return false; // Unknown filter type: not provable.
      }
      line[x] = reconstructed & 0xff;
    }
    position += stride;
    for (let alpha = channels - 1; alpha < stride; alpha += channels) {
      if (line[alpha] !== 0) {
        return false;
      }
    }
    previous.set(line);
  }
  return true;
}

function paethPredictor(left: number, up: number, upLeft: number): number {
  const p = left + up - upLeft;
  const pa = Math.abs(p - left);
  const pb = Math.abs(p - up);
  const pc = Math.abs(p - upLeft);
  if (pa <= pb && pa <= pc) {
    return left;
  }
  return pb <= pc ? up : upLeft;
}

export function slugifyName(name: string) {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "");
  return slug || "scene";
}

export function slugSuffix() {
  return randomBytes(2).toString("hex");
}

export type ValidatedSceneZip = {
  appKeywords: string[];
  frameosVersion: string | undefined;
  imageHeight: number | undefined;
  imageWidth: number | undefined;
  manifestDescription: string | undefined;
  manifestName: string | undefined;
  previewImage: Buffer | undefined;
  riskFlags: string[];
  sceneCount: number;
};

export type SceneZipValidation =
  | { ok: true; value: ValidatedSceneZip }
  | { ok: false; error: string };

// Structural validation of an untrusted template zip (STORE-TODO threat
// model): real zip, bounded size/entries, must contain template.json and a
// non-empty scenes.json at the root or one folder deep — the same layout
// frameos' template_zip_bytes() produces and parse_template_zip() expects.
// Nothing is ever written to disk; we only read the three known files.
export function validateSceneZip(content: Buffer): SceneZipValidation {
  if (content.length > maxSceneZipBytes) {
    return { ok: false, error: "zip_too_large" };
  }

  let entryCount = 0;
  let totalUncompressed = 0;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(new Uint8Array(content), {
      filter: (file) => {
        entryCount += 1;
        totalUncompressed += file.originalSize ?? 0;
        if (
          entryCount > maxSceneZipEntries ||
          totalUncompressed > maxSceneZipUncompressedBytes
        ) {
          throw new Error("zip_bounds_exceeded");
        }
        // Inflate only the files we read; other entries still count against
        // the caps above but are never decompressed.
        return /(^|\/)(template\.json|scenes\.json|image\.jpg)$/.test(
          file.name,
        );
      },
    });
  } catch {
    return { ok: false, error: "invalid_zip" };
  }

  // The shallowest template.json wins, mirroring frameos' parser.
  const manifestPath = Object.keys(files)
    .filter((name) => /(^|\/)template\.json$/.test(name))
    .sort((a, b) => depth(a) - depth(b) || a.localeCompare(b))[0];
  if (!manifestPath || depth(manifestPath) > 1) {
    return { ok: false, error: "missing_template_json" };
  }
  const folder = manifestPath.slice(0, manifestPath.length - "template.json".length);

  const manifestBytes = files[manifestPath];
  const manifest = manifestBytes ? parseJson(manifestBytes) : undefined;
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return { ok: false, error: "invalid_template_json" };
  }

  const scenesRaw = files[`${folder}scenes.json`];
  const scenes = scenesRaw ? parseJson(scenesRaw) : undefined;
  if (!Array.isArray(scenes) || scenes.length === 0) {
    return { ok: false, error: "missing_scenes" };
  }

  const record = manifest as Record<string, unknown>;
  const imageRaw = files[`${folder}image.jpg`];
  if (imageRaw && imageRaw.length > maxPreviewImageBytes) {
    return { ok: false, error: "preview_image_too_large" };
  }
  // A provably all-transparent preview is a broken screenshot (captured
  // before the live preview painted); it would render as a blank tile
  // everywhere the store shows it. Reject at the choke point every publish
  // path funnels through.
  if (imageRaw && isProvablyFullyTransparentImage(imageRaw)) {
    return { ok: false, error: "preview_image_fully_transparent" };
  }

  return {
    ok: true,
    value: {
      appKeywords: extractAppKeywords(scenes),
      frameosVersion: normalizeFrameosVersion(record.frameosVersion),
      imageHeight: dimension(record.imageHeight),
      imageWidth: dimension(record.imageWidth),
      manifestDescription:
        typeof record.description === "string" && record.description.trim()
          ? record.description.trim().slice(0, 2000)
          : undefined,
      manifestName:
        typeof record.name === "string" && record.name.trim()
          ? record.name.trim().slice(0, 128)
          : undefined,
      previewImage: imageRaw ? Buffer.from(imageRaw) : undefined,
      riskFlags: detectRiskFlags(scenes),
      sceneCount: scenes.length,
    },
  };
}

// Swap scenes.json inside the template interchange zip, keeping template.json
// and image.jpg byte-identical — unless `renameTo` is given, which also
// rewrites the manifest's display name (used when forking a scene).
export function rebuildZipWithScenes(
  zipBytes: Buffer,
  scenesJson: string,
  renameTo?: string,
): Buffer | undefined {
  try {
    const files = unzipSync(new Uint8Array(zipBytes), {
      filter: (file) =>
        /(^|\/)(template\.json|scenes\.json|image\.jpg)$/.test(file.name),
    });
    const manifestPath = Object.keys(files)
      .filter((name) => /(^|\/)template\.json$/.test(name))
      .sort(
        (a, b) =>
          a.split("/").length - b.split("/").length || a.localeCompare(b),
      )[0];
    let manifest = manifestPath ? files[manifestPath] : undefined;
    if (!manifestPath || !manifest) {
      return undefined;
    }
    if (renameTo) {
      const parsed = JSON.parse(Buffer.from(manifest).toString("utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return undefined;
      }
      manifest = strToU8(JSON.stringify({ ...parsed, name: renameTo }, null, 2));
    }
    const folder = manifestPath.slice(
      0,
      manifestPath.length - "template.json".length,
    );
    const next: Record<string, Uint8Array> = {
      [manifestPath]: manifest,
      [`${folder}scenes.json`]: strToU8(scenesJson),
    };
    const image = files[`${folder}image.jpg`];
    if (image) {
      next[`${folder}image.jpg`] = image;
    }
    return Buffer.from(zipSync(next));
  } catch {
    return undefined;
  }
}

// Set the minimum FrameOS version in the template manifest while keeping the
// scene and preview bytes unchanged. Changing compatibility metadata publishes
// a new archive version, so past downloads remain auditable.
export function rebuildZipWithFrameosVersion(
  zipBytes: Buffer,
  frameosVersion: string | null,
): Buffer | undefined {
  try {
    const files = unzipSync(new Uint8Array(zipBytes), {
      filter: (file) =>
        /(^|\/)(template\.json|scenes\.json|image\.jpg)$/.test(file.name),
    });
    const manifestPath = Object.keys(files)
      .filter((name) => /(^|\/)template\.json$/.test(name))
      .sort((a, b) => depth(a) - depth(b) || a.localeCompare(b))[0];
    const manifestBytes = manifestPath ? files[manifestPath] : undefined;
    if (!manifestPath || !manifestBytes) {
      return undefined;
    }

    const parsed = parseJson(manifestBytes);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    const manifest = { ...(parsed as Record<string, unknown>) };
    if (frameosVersion) {
      manifest.frameosVersion = frameosVersion;
    } else {
      delete manifest.frameosVersion;
    }

    const folder = manifestPath.slice(
      0,
      manifestPath.length - "template.json".length,
    );
    const scenes = files[`${folder}scenes.json`];
    if (!scenes) {
      return undefined;
    }
    const next: Record<string, Uint8Array> = {
      [manifestPath]: strToU8(JSON.stringify(manifest, null, 2)),
      [`${folder}scenes.json`]: scenes,
    };
    const image = files[`${folder}image.jpg`];
    if (image) {
      next[`${folder}image.jpg`] = image;
    }
    return Buffer.from(zipSync(next));
  } catch {
    return undefined;
  }
}

// Replace the single preview understood by FrameOS with the current lead
// storefront image. Cloud galleries can contain several images, but the
// template interchange format exposes only `image.jpg`; FrameOS/Pillow sniffs
// the real raster format from the bytes, so PNG/WebP/GIF uploads can be stored
// under that conventional path without transcoding them. Dimensions from the
// previous image are removed because FrameOS recomputes them on import.
export function rebuildZipWithPreview(
  zipBytes: Buffer,
  previewImage?: Buffer,
): Buffer | undefined {
  try {
    const files = unzipSync(new Uint8Array(zipBytes), {
      filter: (file) =>
        /(^|\/)(template\.json|scenes\.json|image\.jpg)$/.test(file.name),
    });
    const manifestPath = Object.keys(files)
      .filter((name) => /(^|\/)template\.json$/.test(name))
      .sort((a, b) => depth(a) - depth(b) || a.localeCompare(b))[0];
    const manifestBytes = manifestPath ? files[manifestPath] : undefined;
    if (!manifestPath || !manifestBytes) {
      return undefined;
    }

    const parsed = parseJson(manifestBytes);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    const manifest = { ...(parsed as Record<string, unknown>) };
    delete manifest.imageHeight;
    delete manifest.imageWidth;
    if (previewImage) {
      manifest.image = "./image.jpg";
    } else {
      delete manifest.image;
    }

    const folder = manifestPath.slice(
      0,
      manifestPath.length - "template.json".length,
    );
    const scenes = files[`${folder}scenes.json`];
    if (!scenes) {
      return undefined;
    }
    const next: Record<string, Uint8Array> = {
      [manifestPath]: strToU8(JSON.stringify(manifest, null, 2)),
      [`${folder}scenes.json`]: scenes,
    };
    if (previewImage) {
      next[`${folder}image.jpg`] = new Uint8Array(previewImage);
    }
    return Buffer.from(zipSync(next));
  } catch {
    return undefined;
  }
}

function depth(path: string) {
  return path.split("/").length - 1;
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    return undefined;
  }
}

function dimension(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : undefined;
}

// Untrusted manifest metadata, shown verbatim in listings: accept only a
// short version-shaped token (FrameOS uses CalVer like 2026.7.3).
export function normalizeFrameosVersion(value: unknown) {
  return typeof value === "string" && /^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/.test(value.trim())
    ? value.trim()
    : undefined;
}

export function sceneSummary(scene: {
  category: string | null;
  createdAt: Date;
  description: string | null;
  downloadCount: number;
  featuredAt: Date | null;
  frameosVersion: string | null;
  id: string;
  latestVersion: number;
  name: string;
  riskFlags: string[];
  slug: string;
  status: string;
  tags: string[];
  updatedAt: Date;
  visibility: string;
}) {
  return {
    category: scene.category,
    created_at: scene.createdAt.toISOString(),
    description: scene.description,
    download_count: scene.downloadCount,
    featured: scene.featuredAt !== null,
    frameos_version: scene.frameosVersion,
    id: scene.id,
    latest_version: scene.latestVersion,
    name: scene.name,
    risk_flags: scene.riskFlags,
    slug: scene.slug,
    status: scene.status,
    tags: scene.tags,
    updated_at: scene.updatedAt.toISOString(),
    visibility: scene.visibility,
  };
}

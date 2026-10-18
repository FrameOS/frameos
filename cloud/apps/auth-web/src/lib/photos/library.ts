// The cloud's photo library (docs/photos.md is the contract): rows in
// photo_entries / photo_shares, bytes in the object store under random keys.
//
// Every mutation runs in one transaction under a per-account advisory lock,
// so the quota check, the " (2)" name pick and the subtree rewrite of a move
// all see a library nobody else is changing. Objects are written BEFORE the
// row that points at them (a crash leaves an orphan the sweep collects,
// never a row without bytes) and deleted AFTER the rows that pointed at them
// are gone (a failed delete is logged and left to the sweep).

import { randomBytes } from "node:crypto";
import { and, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import {
  accounts,
  photoBlockedHashes,
  photoEntries,
  photoScanHits,
  photoShares,
} from "@frameos-cloud/db";
import { notifyDiscord } from "../discord";
import { getAccountBaseUrl } from "../env";
import type { FramesDatabase } from "../frames";
import { logWarn } from "../log";
import { type ObjectFile, isValidObjectKey, objectStore } from "../object-store";
import { capturePostHogEvent } from "../posthog-capture";
import { photoQuotaBytesForAccount } from "../usage";
import type { PhotoColors } from "./colors";
import {
  emptyPhotoMetadata,
  type PhotoMetadata,
  type PhotoMetadataRemoval,
  readPhotoMetadataBytes,
  removePhotoMetadataBytes,
} from "./metadata";
import {
  comparePhotoNames,
  comparePhotoPaths,
  isPlayablePhotoName,
  isSameOrBelow,
  joinPhotoPath,
  maxPhotoPathBytes,
  maxPhotoPathDepth,
  photoBasename,
  photoNameWithSuffix,
  photoParent,
  photoPathDepth,
  photoPathPrefixes,
  photoPathWithinLimits,
  parsePhotoPath,
} from "./paths";
import type { PhotoScanner } from "./scan";

// A photographer's full-size file. A chunked upload stays on disk to the
// end: it is hashed, scanned, thumbnailed and streamed to the object store
// from its file, never held whole in memory.
export const maxPhotoUploadBytes = 250 * 1024 * 1024;
// nginx caps request bodies at 10 MB; 4 MiB chunks stay well inside it.
export const maxPhotoChunkBytes = 4 * 1024 * 1024;
// Rows, not bytes: empty folders cost nothing against the byte quota, so
// the row count has a ceiling of its own.
export const maxPhotoEntriesPerAccount = 100_000;
export const maxSharedPhotoFiles = 10_000;
// Every byte stored must pass the scan, so the cloud takes the four image
// types the scanners can read (sniffed from the bytes, never the name).
export const acceptedPhotoContentTypes = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
] as const;

export const photosSuspendedMessage =
  "Photos are turned off for this account. Contact support if you think this is a mistake.";

/** A refusal with the status code the contract gives it. */
export class PhotoError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly extra?: Record<string, unknown>,
  ) {
    super(code);
  }
}

export type PhotoEntry = {
  // Files only: the color profile, or null (docs/photos.md "Colors").
  colors?: PhotoColors | null;
  content_type: string | null;
  cover?: string | null;
  files?: number;
  height: number | null;
  items?: number;
  kind: "file" | "folder";
  // Where the photo was taken (docs/photos.md "Metadata"), or null: none,
  // not read yet, or a folder. Never in the share routes' JSON.
  location: PhotoEntryLocation | null;
  mtime: number;
  name: string;
  path: string;
  size: number;
  status: string;
  width: number | null;
};

export type PhotoEntryLocation = { latitude: number; longitude: number };

type EntryRow = {
  colors: PhotoColors | null;
  contentType: string | null;
  createdAt: Date;
  height: number | null;
  kind: string;
  // metadata -> 'location': the stored Metadata's location, or null.
  location: unknown;
  path: string;
  sizeBytes: number;
  status: string;
  width: number | null;
};

const entryColumns = {
  colors: photoEntries.colors,
  contentType: photoEntries.contentType,
  createdAt: photoEntries.createdAt,
  height: photoEntries.height,
  kind: photoEntries.kind,
  // Only the location: a listing must not carry every photo's fields.
  location: sql<unknown>`${photoEntries.metadata} -> 'location'`,
  path: photoEntries.path,
  sizeBytes: photoEntries.sizeBytes,
  status: photoEntries.status,
  width: photoEntries.width,
};

/** The listing's pin: the stored location without its altitude. */
function entryLocation(value: unknown): PhotoEntryLocation | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const { latitude, longitude } = value as Record<string, unknown>;
  return typeof latitude === "number" && typeof longitude === "number" ? { latitude, longitude } : null;
}

function seconds(date: Date) {
  return Math.floor(date.getTime() / 1000);
}

// `path` itself or anything below it. starts_with needs no LIKE escaping, so
// a folder called "50%_off" matches only itself.
function atOrBelow(column: AnyPgColumn, path: string): SQL {
  return sql`(${column} = ${path} or starts_with(${column}, ${`${path}/`}))`;
}

function strictlyBelow(column: AnyPgColumn, path: string): SQL {
  return path === "" ? sql`true` : sql`starts_with(${column}, ${`${path}/`})`;
}

function isCoverImage(row: EntryRow) {
  return (
    row.kind === "file" &&
    row.status === "ready" &&
    Boolean(row.contentType?.startsWith("image/"))
  );
}

function byName(a: EntryRow, b: EntryRow) {
  return comparePhotoNames(photoBasename(a.path), photoBasename(b.path));
}

/**
 * Entries for the direct children of `parent` found in `rows`, which must
 * hold every row below each child that should be counted (folder `items`,
 * `files`, `size` and `cover` come from them). Folders first, then by name.
 */
export function describePhotoChildren(parent: string, rows: EntryRow[]): PhotoEntry[] {
  const prefix = parent === "" ? "" : `${parent}/`;
  const children: EntryRow[] = [];
  const stats = new Map<string, { files: number; items: number; size: number }>();
  // Rows grouped by their parent folder, for the covers.
  const byParent = new Map<string, { folders: EntryRow[]; images: EntryRow[] }>();

  for (const row of rows) {
    if (!row.path.startsWith(prefix) || row.path.length === prefix.length) {
      continue;
    }
    if (!row.path.slice(prefix.length).includes("/")) {
      children.push(row);
      if (row.kind === "folder") {
        stats.set(row.path, { files: 0, items: 0, size: 0 });
      }
    }
    const folder = photoParent(row.path);
    let group = byParent.get(folder);
    if (!group) {
      group = { folders: [], images: [] };
      byParent.set(folder, group);
    }
    if (row.kind === "folder") {
      group.folders.push(row);
    } else if (isCoverImage(row)) {
      group.images.push(row);
    }
  }

  for (const row of rows) {
    const relative = row.path.slice(prefix.length);
    const slash = relative.indexOf("/");
    if (!row.path.startsWith(prefix) || slash < 0) {
      continue;
    }
    const top = stats.get(prefix + relative.slice(0, slash));
    if (!top) {
      continue;
    }
    if (!relative.slice(slash + 1).includes("/")) {
      top.items += 1;
    }
    if (row.kind === "file") {
      top.files += 1;
      top.size += Number(row.sizeBytes);
    }
  }

  const firstImage = (folder: string) =>
    [...(byParent.get(folder)?.images ?? [])].sort(byName)[0]?.path;
  // The first image among the direct children by name, else the first one
  // found in the subfolders by name, however deep (docs/photos.md).
  const coverOf = (folder: string): string | null => {
    const direct = firstImage(folder);
    if (direct) {
      return direct;
    }
    const subfolders = [...(byParent.get(folder)?.folders ?? [])].sort(byName);
    for (const subfolder of subfolders) {
      const nested = coverOf(subfolder.path);
      if (nested) {
        return nested;
      }
    }
    return null;
  };

  return children
    .sort((a, b) => {
      if (a.kind !== b.kind) {
        return a.kind === "folder" ? -1 : 1;
      }
      return byName(a, b);
    })
    .map((row) => {
      const base = {
        mtime: seconds(row.createdAt),
        name: photoBasename(row.path),
        path: row.path,
      };
      if (row.kind === "folder") {
        const folderStats = stats.get(row.path) ?? { files: 0, items: 0, size: 0 };
        return {
          ...base,
          content_type: null,
          cover: coverOf(row.path),
          files: folderStats.files,
          height: null,
          items: folderStats.items,
          kind: "folder" as const,
          location: null,
          size: folderStats.size,
          status: row.status,
          width: null,
        };
      }
      return {
        ...base,
        colors: row.colors ?? null,
        content_type: row.contentType,
        height: row.height,
        kind: "file" as const,
        location: entryLocation(row.location),
        size: Number(row.sizeBytes),
        status: row.status,
        width: row.width,
      };
    });
}

async function rowsAtOrBelow(db: FramesDatabase, accountId: string, path: string) {
  return db
    .select(entryColumns)
    .from(photoEntries)
    .where(
      and(
        eq(photoEntries.accountId, accountId),
        path === "" ? sql`true` : atOrBelow(photoEntries.path, path),
      ),
    );
}

async function rowAt(db: FramesDatabase, accountId: string, path: string) {
  const [row] = await db
    .select({
      kind: photoEntries.kind,
      objectKey: photoEntries.objectKey,
      path: photoEntries.path,
      thumbObjectKey: photoEntries.thumbObjectKey,
    })
    .from(photoEntries)
    .where(and(eq(photoEntries.accountId, accountId), eq(photoEntries.path, path)))
    .limit(1);
  return row;
}

/** One entry, in the listing shape, or undefined when nothing is there. */
export async function loadPhotoEntry(
  db: FramesDatabase,
  accountId: string,
  path: string,
): Promise<PhotoEntry | undefined> {
  if (path === "") {
    return undefined;
  }
  const rows = await rowsAtOrBelow(db, accountId, path);
  return describePhotoChildren(photoParent(path), rows).find((entry) => entry.path === path);
}

/** The direct children of a folder (the root is ""). 404 for no such folder. */
export async function listPhotoFolder(
  db: FramesDatabase,
  accountId: string,
  folder: string,
): Promise<PhotoEntry[]> {
  if (folder !== "") {
    const row = await rowAt(db, accountId, folder);
    if (!row || row.kind !== "folder") {
      throw new PhotoError("not_found", 404);
    }
  }
  const rows = await db
    .select(entryColumns)
    .from(photoEntries)
    .where(
      and(eq(photoEntries.accountId, accountId), strictlyBelow(photoEntries.path, folder)),
    );
  return describePhotoChildren(folder, rows);
}

/** A file's stored objects, for the owner's file and thumbnail routes. */
export async function photoFileObjects(
  db: FramesDatabase,
  accountId: string,
  path: string,
) {
  const [row] = await db
    .select({
      contentType: photoEntries.contentType,
      kind: photoEntries.kind,
      objectKey: photoEntries.objectKey,
      sizeBytes: photoEntries.sizeBytes,
      status: photoEntries.status,
      thumbObjectKey: photoEntries.thumbObjectKey,
    })
    .from(photoEntries)
    .where(and(eq(photoEntries.accountId, accountId), eq(photoEntries.path, path)))
    .limit(1);
  return row?.kind === "file" ? row : undefined;
}

// ---------------------------------------------------------------------------
// Account state and usage

export async function photosSuspendedAt(
  db: FramesDatabase,
  accountId: string,
): Promise<Date | null> {
  const [row] = await db
    .select({ suspendedAt: accounts.photosSuspendedAt })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  return row?.suspendedAt ?? null;
}

/** 503 while the library is not ready (today: only a suspension). */
export async function assertPhotosAvailable(db: FramesDatabase, accountId: string) {
  if (await photosSuspendedAt(db, accountId)) {
    throw new PhotoError("photos_unavailable", 503, {
      message: photosSuspendedMessage,
      problem: "suspended",
    });
  }
}

export async function photoLibraryTotals(
  db: FramesDatabase,
  accountId: string,
): Promise<{ bytes: number; entries: number }> {
  const [row] = await db
    .select({
      bytes: sql<number>`coalesce(sum(${photoEntries.sizeBytes}) filter (where ${photoEntries.kind} = 'file'), 0)::float8`,
      entries: sql<number>`count(*)::int`,
    })
    .from(photoEntries)
    .where(eq(photoEntries.accountId, accountId));
  return { bytes: Number(row?.bytes ?? 0), entries: Number(row?.entries ?? 0) };
}

/** 507 when `extraBytes` more would not fit in the account's photo quota. */
export async function assertPhotoQuota(
  db: FramesDatabase,
  accountId: string,
  extraBytes: number,
  extraEntries = 0,
) {
  const [totals, quotaBytes] = await Promise.all([
    photoLibraryTotals(db, accountId),
    photoQuotaBytesForAccount(db, accountId),
  ]);
  if (totals.bytes + extraBytes > quotaBytes) {
    throw new PhotoError("storage_quota_exceeded", 507, {
      max_bytes: quotaBytes,
      used_bytes: Math.round(totals.bytes),
    });
  }
  if (totals.entries + extraEntries > maxPhotoEntriesPerAccount) {
    throw new PhotoError("entry_limit_reached", 507, {
      max_entries: maxPhotoEntriesPerAccount,
    });
  }
}

async function lockPhotoLibrary(tx: FramesDatabase, accountId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`photos:${accountId}`}))`);
}

// ---------------------------------------------------------------------------
// Objects

function randomPhotoObjectKey(accountId: string, kind: "file" | "thumb") {
  const id = randomBytes(16).toString("hex");
  const key =
    kind === "file" ? `photos/${accountId}/${id}` : `photos/${accountId}/thumbs/${id}`;
  if (!isValidObjectKey(key)) {
    throw new Error(`Invalid photo object key: ${JSON.stringify(key)}`);
  }
  return key;
}

/** Delete objects whose rows are gone. Failures are logged, never thrown. */
export async function deletePhotoObjects(keys: (string | null | undefined)[]) {
  const pending = keys.filter((key): key is string => Boolean(key));
  const store = objectStore();
  const worker = async () => {
    for (let key = pending.pop(); key !== undefined; key = pending.pop()) {
      try {
        await store.delete(key);
      } catch (error) {
        // The row is gone, so the request that freed the space succeeded;
        // scripts/object-store-sweep.sh collects what is left behind.
        logWarn("photos.object_delete_failed", {
          error: error instanceof Error ? error.message : String(error),
          objectKey: key,
        });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, pending.length) }, worker));
}

// ---------------------------------------------------------------------------
// Folders and names

async function pathTaken(tx: FramesDatabase, accountId: string, path: string) {
  const [row] = await tx
    .select({ path: photoEntries.path })
    .from(photoEntries)
    .where(and(eq(photoEntries.accountId, accountId), eq(photoEntries.path, path)))
    .limit(1);
  return Boolean(row);
}

/** `name`, or the first free `name (n)` among the folder's children. */
async function freeChildName(
  tx: FramesDatabase,
  accountId: string,
  folder: string,
  name: string,
): Promise<string> {
  if (!(await pathTaken(tx, accountId, joinPhotoPath(folder, name)))) {
    return name;
  }
  const prefix = folder === "" ? "" : `${folder}/`;
  const rows = await tx
    .select({ path: photoEntries.path })
    .from(photoEntries)
    .where(
      and(eq(photoEntries.accountId, accountId), strictlyBelow(photoEntries.path, folder)),
    );
  const names = new Set(
    rows
      .map((row) => row.path.slice(prefix.length))
      .filter((relative) => !relative.includes("/")),
  );
  for (let counter = 2; ; counter += 1) {
    const candidate = photoNameWithSuffix(name, counter);
    if (!names.has(candidate)) {
      return candidate;
    }
  }
}

/** Create the folder and every missing folder above it. */
async function ensurePhotoFolders(tx: FramesDatabase, accountId: string, folder: string) {
  const prefixes = photoPathPrefixes(folder);
  if (prefixes.length === 0) {
    return 0;
  }
  const existing = await tx
    .select({ kind: photoEntries.kind, path: photoEntries.path })
    .from(photoEntries)
    .where(and(eq(photoEntries.accountId, accountId), inArray(photoEntries.path, prefixes)));
  const kinds = new Map(existing.map((row) => [row.path, row.kind]));
  const missing: string[] = [];
  for (const prefix of prefixes) {
    const kind = kinds.get(prefix);
    if (kind === "file") {
      throw new PhotoError("parent_is_file", 409, { path: prefix });
    }
    if (!kind) {
      missing.push(prefix);
    }
  }
  if (missing.length > 0) {
    await tx
      .insert(photoEntries)
      .values(missing.map((path) => ({ accountId, kind: "folder", path })));
  }
  return missing.length;
}

// The folder's updated_at says "something directly inside changed", which is
// what a share link's `updated_at` is built from.
async function touchPhotoFolder(tx: FramesDatabase, accountId: string, folder: string) {
  if (folder === "") {
    return;
  }
  await tx
    .update(photoEntries)
    .set({ updatedAt: new Date() })
    .where(and(eq(photoEntries.accountId, accountId), eq(photoEntries.path, folder)));
}

/** POST /api/photos/folders: a new folder and its missing parents. */
export async function createPhotoFolder(
  db: FramesDatabase,
  accountId: string,
  path: string,
): Promise<PhotoEntry> {
  await db.transaction(async (tx) => {
    await lockPhotoLibrary(tx, accountId);
    await assertPhotosAvailable(tx, accountId);
    if (await pathTaken(tx, accountId, path)) {
      throw new PhotoError("exists", 409);
    }
    await assertPhotoQuota(tx, accountId, 0, photoPathDepth(path));
    await ensurePhotoFolders(tx, accountId, path);
    await touchPhotoFolder(tx, accountId, photoParent(path));
  });
  return (await loadPhotoEntry(db, accountId, path)) as PhotoEntry;
}

// ---------------------------------------------------------------------------
// Uploads

export type StorePhotoInput = {
  /** The scanned file: bytes, or a finished upload still on disk. */
  body: Buffer | ObjectFile;
  size: number;
  contentType: string;
  folder: string;
  height: number | null;
  /** What the photo carries (metadata.ts), read at upload. */
  metadata: PhotoMetadata | null;
  name: string;
  sha256: string;
  /** The JPEG from makePhotoThumbnail, or null when there is none. */
  thumbnail: Buffer | null;
  width: number | null;
};

/**
 * Store one scanned file: the objects first (the file, its thumbnail), then
 * the row (with a " (2)" name when the name is taken). Quota and suspension
 * are checked again under the lock; a refusal there deletes the objects it
 * just wrote.
 */
export async function storePhotoFile(
  db: FramesDatabase,
  accountId: string,
  input: StorePhotoInput,
): Promise<PhotoEntry> {
  const objectKey = randomPhotoObjectKey(accountId, "file");
  const thumbObjectKey = input.thumbnail ? randomPhotoObjectKey(accountId, "thumb") : null;
  await objectStore().put(objectKey, input.body, input.contentType);
  try {
    if (thumbObjectKey && input.thumbnail) {
      await objectStore().put(thumbObjectKey, input.thumbnail, "image/jpeg");
    }
  } catch (error) {
    await deletePhotoObjects([objectKey, thumbObjectKey]);
    throw error;
  }
  let path: string;
  try {
    path = await db.transaction(async (tx) => {
      await lockPhotoLibrary(tx, accountId);
      await assertPhotosAvailable(tx, accountId);
      await assertPhotoQuota(tx, accountId, input.size, 1 + photoPathDepth(input.folder));
      await ensurePhotoFolders(tx, accountId, input.folder);
      const name = await freeChildName(tx, accountId, input.folder, input.name);
      const target = joinPhotoPath(input.folder, name);
      if (!photoPathWithinLimits(target)) {
        throw new PhotoError("invalid_path", 400);
      }
      await tx.insert(photoEntries).values({
        accountId,
        contentType: input.contentType,
        height: input.height,
        kind: "file",
        metadata: input.metadata,
        objectKey,
        path: target,
        sha256: input.sha256,
        sizeBytes: input.size,
        thumbObjectKey,
        width: input.width,
      });
      await touchPhotoFolder(tx, accountId, input.folder);
      return target;
    });
  } catch (error) {
    await deletePhotoObjects([objectKey, thumbObjectKey]);
    throw error;
  }
  return (await loadPhotoEntry(db, accountId, path)) as PhotoEntry;
}

export type ReplacePhotoInput = {
  body: Buffer;
  contentType: string;
  /** The extension the new bytes call for (".jpg"); the name follows it when it differs. */
  extension: string;
  height: number | null;
  /** What the new bytes carry (metadata.ts). */
  metadata: PhotoMetadata | null;
  sha256: string;
  size: number;
  thumbnail: Buffer | null;
  width: number | null;
};

/**
 * Replace a photo's bytes in place (POST /api/photos/resize): new objects,
 * then the row updated under the lock (its colors, its date and its share
 * links untouched); the old objects go when the row no longer names them.
 * A format change renames the file to a free name with the new extension.
 */
export async function replacePhotoFile(
  db: FramesDatabase,
  accountId: string,
  path: string,
  input: ReplacePhotoInput,
): Promise<PhotoEntry> {
  const objectKey = randomPhotoObjectKey(accountId, "file");
  const thumbObjectKey = input.thumbnail ? randomPhotoObjectKey(accountId, "thumb") : null;
  await objectStore().put(objectKey, input.body, input.contentType);
  try {
    if (thumbObjectKey && input.thumbnail) {
      await objectStore().put(thumbObjectKey, input.thumbnail, "image/jpeg");
    }
  } catch (error) {
    await deletePhotoObjects([objectKey, thumbObjectKey]);
    throw error;
  }
  let target: string;
  let oldKeys: (string | null)[] = [];
  try {
    target = await db.transaction(async (tx) => {
      await lockPhotoLibrary(tx, accountId);
      await assertPhotosAvailable(tx, accountId);
      const [row] = await tx
        .select({
          kind: photoEntries.kind,
          objectKey: photoEntries.objectKey,
          sizeBytes: photoEntries.sizeBytes,
          status: photoEntries.status,
          thumbObjectKey: photoEntries.thumbObjectKey,
        })
        .from(photoEntries)
        .where(and(eq(photoEntries.accountId, accountId), eq(photoEntries.path, path)))
        .limit(1);
      if (!row || row.kind !== "file" || row.status !== "ready") {
        throw new PhotoError("not_found", 404);
      }
      const growth = input.size - Number(row.sizeBytes);
      if (growth > 0) {
        await assertPhotoQuota(tx, accountId, growth, 0);
      }
      const folder = photoParent(path);
      const name = photoBasename(path);
      const dot = name.lastIndexOf(".");
      const currentExtension = dot > 0 ? name.slice(dot).toLowerCase() : "";
      let next = path;
      if (currentExtension !== input.extension) {
        const stem = dot > 0 ? name.slice(0, dot) : name;
        const free = await freeChildName(tx, accountId, folder, `${stem}${input.extension}`);
        next = joinPhotoPath(folder, free);
        if (!photoPathWithinLimits(next)) {
          throw new PhotoError("invalid_path", 400);
        }
      }
      oldKeys = [row.objectKey, row.thumbObjectKey];
      await tx
        .update(photoEntries)
        .set({
          contentType: input.contentType,
          height: input.height,
          metadata: input.metadata,
          objectKey,
          path: next,
          sha256: input.sha256,
          sizeBytes: input.size,
          thumbObjectKey,
          updatedAt: new Date(),
          width: input.width,
        })
        .where(and(eq(photoEntries.accountId, accountId), eq(photoEntries.path, path)));
      await touchPhotoFolder(tx, accountId, folder);
      return next;
    });
  } catch (error) {
    await deletePhotoObjects([objectKey, thumbObjectKey]);
    throw error;
  }
  await deletePhotoObjects(oldKeys);
  return (await loadPhotoEntry(db, accountId, target)) as PhotoEntry;
}

// ---------------------------------------------------------------------------
// Move, rename, delete

async function assertSubtreeFits(
  tx: FramesDatabase,
  accountId: string,
  from: string,
  to: string,
) {
  const [row] = await tx
    .select({
      maxBytes: sql<number>`coalesce(max(octet_length(${photoEntries.path})), 0)::int`,
      maxDepth: sql<number>`coalesce(max(array_length(string_to_array(${photoEntries.path}, '/'), 1)), 0)::int`,
    })
    .from(photoEntries)
    .where(and(eq(photoEntries.accountId, accountId), atOrBelow(photoEntries.path, from)));
  const bytes =
    Number(row?.maxBytes ?? 0) - Buffer.byteLength(from) + Buffer.byteLength(to);
  const depth = Number(row?.maxDepth ?? 0) - photoPathDepth(from) + photoPathDepth(to);
  if (bytes > maxPhotoPathBytes || depth > maxPhotoPathDepth) {
    throw new PhotoError("path_too_long", 400, { path: to });
  }
}

// Rewrite the paths of `from` and everything below it, and of the share
// links pointing there. The caller made sure `to` is free (and so is
// everything below it: every row's parent has a row).
async function rewriteSubtree(
  tx: FramesDatabase,
  accountId: string,
  from: string,
  to: string,
) {
  const now = new Date();
  await tx
    .update(photoEntries)
    .set({
      path: sql`${to} || substr(${photoEntries.path}, char_length(${from}) + 1)`,
      updatedAt: now,
    })
    .where(and(eq(photoEntries.accountId, accountId), atOrBelow(photoEntries.path, from)));
  await tx
    .update(photoShares)
    .set({ path: sql`${to} || substr(${photoShares.path}, char_length(${from}) + 1)` })
    .where(and(eq(photoShares.accountId, accountId), atOrBelow(photoShares.path, from)));
}

// Drop paths that sit below another path in the same request: they travel
// with their folder.
function outermostPaths(paths: string[]) {
  const unique = [...new Set(paths)];
  return unique.filter(
    (path) => !unique.some((other) => other !== path && isSameOrBelow(path, other)),
  );
}

export async function movePhotoEntries(
  db: FramesDatabase,
  accountId: string,
  paths: string[],
  to: string,
): Promise<{ from: string; to: string }[]> {
  return db.transaction(async (tx) => {
    await lockPhotoLibrary(tx, accountId);
    await assertPhotosAvailable(tx, accountId);
    if (to !== "") {
      const destination = await rowAt(tx, accountId, to);
      if (!destination) {
        throw new PhotoError("not_found", 404, { path: to });
      }
      if (destination.kind !== "folder") {
        throw new PhotoError("not_a_folder", 400, { path: to });
      }
    }
    // Every path is checked before anything moves.
    const kinds = new Map<string, string>();
    for (const path of new Set(paths)) {
      const row = await rowAt(tx, accountId, path);
      if (!row) {
        throw new PhotoError("not_found", 404, { path });
      }
      kinds.set(path, row.kind);
      if (row.kind === "folder" && isSameOrBelow(to, path)) {
        throw new PhotoError("invalid_move", 400, { path });
      }
    }

    const movedTo = new Map<string, string>();
    for (const from of outermostPaths(paths)) {
      const parent = photoParent(from);
      if (parent === to) {
        movedTo.set(from, from);
        continue;
      }
      const name = await freeChildName(tx, accountId, to, photoBasename(from));
      const target = joinPhotoPath(to, name);
      await assertSubtreeFits(tx, accountId, from, target);
      await rewriteSubtree(tx, accountId, from, target);
      await touchPhotoFolder(tx, accountId, parent);
      await touchPhotoFolder(tx, accountId, to);
      movedTo.set(from, target);
    }
    const unique = [...new Set(paths)];
    return unique.map((from) => {
      const direct = movedTo.get(from);
      if (direct !== undefined) {
        return { from, to: direct };
      }
      // Below a folder that moved in the same request.
      const ancestor = [...movedTo.keys()].find((path) => isSameOrBelow(from, path)) ?? from;
      const ancestorTarget = movedTo.get(ancestor) ?? ancestor;
      return { from, to: ancestorTarget + from.slice(ancestor.length) };
    });
  });
}

export async function renamePhotoEntry(
  db: FramesDatabase,
  accountId: string,
  path: string,
  name: string,
): Promise<PhotoEntry> {
  const target = joinPhotoPath(photoParent(path), name);
  await db.transaction(async (tx) => {
    await lockPhotoLibrary(tx, accountId);
    await assertPhotosAvailable(tx, accountId);
    const row = await rowAt(tx, accountId, path);
    if (!row) {
      throw new PhotoError("not_found", 404);
    }
    if (target === path) {
      return;
    }
    if (await pathTaken(tx, accountId, target)) {
      throw new PhotoError("exists", 409);
    }
    await assertSubtreeFits(tx, accountId, path, target);
    await rewriteSubtree(tx, accountId, path, target);
    await touchPhotoFolder(tx, accountId, photoParent(path));
  });
  return (await loadPhotoEntry(db, accountId, target)) as PhotoEntry;
}

/**
 * POST /api/photos/colors: set a photo's color profile, or remove it with
 * null. 404 for nothing there (or a file a scan blocked), 400 for a folder
 * or a file a frame cannot play. Only the row changes: the profile follows
 * the photo through moves and renames and goes with it on delete.
 */
export async function setPhotoColors(
  db: FramesDatabase,
  accountId: string,
  path: string,
  colors: PhotoColors | null,
): Promise<PhotoEntry> {
  await db.transaction(async (tx) => {
    await lockPhotoLibrary(tx, accountId);
    await assertPhotosAvailable(tx, accountId);
    const [row] = await tx
      .select({ kind: photoEntries.kind, status: photoEntries.status })
      .from(photoEntries)
      .where(and(eq(photoEntries.accountId, accountId), eq(photoEntries.path, path)))
      .limit(1);
    if (!row || (row.kind === "file" && row.status !== "ready")) {
      throw new PhotoError("not_found", 404);
    }
    if (row.kind !== "file") {
      throw new PhotoError("not_a_file", 400);
    }
    if (!isPlayablePhotoName(photoBasename(path))) {
      throw new PhotoError("not_playable", 400);
    }
    // updated_at, not created_at: `mtime` stays the file's, while a share
    // link's `updated_at` says the album changed.
    await tx
      .update(photoEntries)
      .set({ colors, updatedAt: new Date() })
      .where(and(eq(photoEntries.accountId, accountId), eq(photoEntries.path, path)));
    await touchPhotoFolder(tx, accountId, photoParent(path));
  });
  return (await loadPhotoEntry(db, accountId, path)) as PhotoEntry;
}

// ---------------------------------------------------------------------------
// Metadata (docs/photos.md "Metadata", src/lib/photos/metadata.ts)

// The types the reader reads; any other file's metadata is empty, unread.
const metadataContentTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
// What one folder listing reads in the background, two at a time. A photo
// over the size cap waits for GET /api/photos/metadata, which reads any.
export const photoMetadataReadsPerListing = 200;
const backgroundMetadataMaxBytes = 64 * 1024 * 1024;
const metadataWorkers = 2;
const rewriteWorkers = 4;

/** What a stored object carries: read from the bucket, or empty for a GIF. */
async function readObjectMetadata(objectKey: string | null, contentType: string | null): Promise<PhotoMetadata> {
  if (!contentType || !metadataContentTypes.has(contentType)) {
    return emptyPhotoMetadata();
  }
  const bytes = objectKey ? await objectStore().get(objectKey) : undefined;
  if (!bytes) {
    throw new PhotoError("not_found", 404);
  }
  return readPhotoMetadataBytes(bytes);
}

/** Store what was read, unless the photo's bytes changed in between. */
async function savePhotoMetadata(
  db: FramesDatabase,
  accountId: string,
  path: string,
  objectKey: string,
  metadata: PhotoMetadata,
) {
  // Not updated_at: reading changes nothing a share link shows.
  await db
    .update(photoEntries)
    .set({ metadata })
    .where(
      and(
        eq(photoEntries.accountId, accountId),
        eq(photoEntries.path, path),
        eq(photoEntries.objectKey, objectKey),
      ),
    );
}

/**
 * GET /api/photos/metadata: a file's stored metadata, or the object read
 * (and the result stored) when the photo has none yet. 404 for nothing
 * there (or a blocked file), 400 for a folder.
 */
export async function photoMetadata(db: FramesDatabase, accountId: string, path: string): Promise<PhotoMetadata> {
  const [row] = await db
    .select({
      contentType: photoEntries.contentType,
      kind: photoEntries.kind,
      metadata: photoEntries.metadata,
      objectKey: photoEntries.objectKey,
      status: photoEntries.status,
    })
    .from(photoEntries)
    .where(and(eq(photoEntries.accountId, accountId), eq(photoEntries.path, path)))
    .limit(1);
  if (!row || (row.kind === "file" && row.status !== "ready")) {
    throw new PhotoError("not_found", 404);
  }
  if (row.kind !== "file") {
    throw new PhotoError("not_a_file", 400);
  }
  if (row.metadata) {
    return row.metadata as PhotoMetadata;
  }
  const metadata = await readObjectMetadata(row.objectKey, row.contentType);
  if (row.objectKey) {
    await savePhotoMetadata(db, accountId, path, row.objectKey, metadata);
  }
  return metadata;
}

/**
 * Read the metadata of the photos directly in `folder` that have none yet
 * (stored before photos had it), at most photoMetadataReadsPerListing of
 * them, so the next listing shows their pins. What GET /api/photos/files
 * runs after answering. A photo that cannot be read is logged and left for
 * the next listing. Returns how many were read.
 */
export async function readUnreadPhotoMetadata(db: FramesDatabase, accountId: string, folder: string): Promise<number> {
  const prefix = folder === "" ? "" : `${folder}/`;
  const rows = await db
    .select({
      contentType: photoEntries.contentType,
      objectKey: photoEntries.objectKey,
      path: photoEntries.path,
      sizeBytes: photoEntries.sizeBytes,
    })
    .from(photoEntries)
    .where(
      and(
        eq(photoEntries.accountId, accountId),
        strictlyBelow(photoEntries.path, folder),
        // Direct children only: nothing after the folder's prefix holds a "/".
        sql`strpos(substr(${photoEntries.path}, char_length(${prefix}) + 1), '/') = 0`,
        eq(photoEntries.kind, "file"),
        eq(photoEntries.status, "ready"),
        isNull(photoEntries.metadata),
        sql`${photoEntries.sizeBytes} <= ${backgroundMetadataMaxBytes}`,
      ),
    )
    .limit(photoMetadataReadsPerListing);
  let read = 0;
  const pending = [...rows];
  const worker = async () => {
    for (let row = pending.shift(); row !== undefined; row = pending.shift()) {
      if (!row.objectKey) {
        continue;
      }
      try {
        const metadata = await readObjectMetadata(row.objectKey, row.contentType);
        await savePhotoMetadata(db, accountId, row.path, row.objectKey, metadata);
        read += 1;
      } catch (error) {
        logWarn("photos.metadata_read_failed", {
          error: error instanceof Error ? error.message : String(error),
          objectKey: row.objectKey,
        });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(metadataWorkers, pending.length) }, worker));
  return read;
}

/**
 * POST /api/photos/metadata: take the location, or all metadata, out of
 * files (metadata.ts). Every path is checked first: one missing is a 404,
 * one folder a 400, and nothing changes. A file that is not a JPEG, PNG or
 * WebP, a blocked one, or one with nothing to remove is left alone. A
 * changed file gets new bytes under a new key, its size, SHA-256 and
 * metadata again; its path, date, colors, thumbnail and share links stay.
 * The old object goes once the row has moved on.
 */
export async function removePhotoMetadata(
  db: FramesDatabase,
  accountId: string,
  paths: string[],
  removal: PhotoMetadataRemoval,
): Promise<{ changed: number; entries: PhotoEntry[] }> {
  const unique = [...new Set(paths)];
  const rows = await db
    .select({
      contentType: photoEntries.contentType,
      kind: photoEntries.kind,
      metadata: photoEntries.metadata,
      objectKey: photoEntries.objectKey,
      path: photoEntries.path,
      sizeBytes: photoEntries.sizeBytes,
      status: photoEntries.status,
    })
    .from(photoEntries)
    .where(and(eq(photoEntries.accountId, accountId), inArray(photoEntries.path, unique)));
  const byPath = new Map(rows.map((row) => [row.path, row]));
  for (const path of unique) {
    const row = byPath.get(path);
    if (!row) {
      throw new PhotoError("not_found", 404, { path });
    }
    if (row.kind !== "file") {
      throw new PhotoError("not_a_file", 400, { path });
    }
  }

  let changed = 0;
  const pending = unique.map((path) => byPath.get(path)!);
  const rewrite = async (row: (typeof rows)[number]) => {
    if (row.status !== "ready" || !row.objectKey || !row.contentType || !metadataContentTypes.has(row.contentType)) {
      return;
    }
    const bytes = await objectStore().get(row.objectKey);
    if (!bytes) {
      return;
    }
    const result = await removePhotoMetadataBytes(bytes, removal);
    if (!result.changed || !Buffer.isBuffer(result.body)) {
      if (!row.metadata) {
        await savePhotoMetadata(db, accountId, row.path, row.objectKey, await readPhotoMetadataBytes(bytes));
      }
      return;
    }
    const body = result.body;
    const metadata = await readPhotoMetadataBytes(body);
    const objectKey = randomPhotoObjectKey(accountId, "file");
    await objectStore().put(objectKey, body, row.contentType);
    let moved = false;
    try {
      moved = await db.transaction(async (tx) => {
        await lockPhotoLibrary(tx, accountId);
        await assertPhotosAvailable(tx, accountId);
        const growth = body.length - Number(row.sizeBytes);
        if (growth > 0) {
          await assertPhotoQuota(tx, accountId, growth, 0);
        }
        // Only the bytes this read: a photo replaced, moved or deleted in
        // between is left to what happened to it.
        const updated = await tx
          .update(photoEntries)
          .set({ metadata, objectKey, sha256: result.sha256, sizeBytes: body.length, updatedAt: new Date() })
          .where(
            and(
              eq(photoEntries.accountId, accountId),
              eq(photoEntries.path, row.path),
              eq(photoEntries.objectKey, row.objectKey as string),
              eq(photoEntries.status, "ready"),
            ),
          )
          .returning({ id: photoEntries.id });
        if (updated.length > 0) {
          await touchPhotoFolder(tx, accountId, photoParent(row.path));
        }
        return updated.length > 0;
      });
    } catch (error) {
      await deletePhotoObjects([objectKey]);
      throw error;
    }
    if (!moved) {
      await deletePhotoObjects([objectKey]);
      return;
    }
    await deletePhotoObjects([row.objectKey]);
    changed += 1;
  };
  const worker = async () => {
    for (let row = pending.shift(); row !== undefined; row = pending.shift()) {
      await rewrite(row);
    }
  };
  await Promise.all(Array.from({ length: Math.min(rewriteWorkers, pending.length) }, worker));

  // The entries, in request order: one query, each file its own entry.
  const after = await db
    .select(entryColumns)
    .from(photoEntries)
    .where(and(eq(photoEntries.accountId, accountId), inArray(photoEntries.path, unique)));
  const entries = new Map(
    after.map((row) => [row.path, describePhotoChildren(photoParent(row.path), [row])[0]] as const),
  );
  return {
    changed,
    entries: paths.map((path) => entries.get(path)).filter((entry): entry is PhotoEntry => entry !== undefined),
  };
}

/**
 * Delete files and folders (with everything in them, and the share links at
 * or below them). Paths that are not there are skipped. Returns how many of
 * the requested paths were deleted and the folders among them.
 */
export async function deletePhotoEntries(
  db: FramesDatabase,
  accountId: string,
  paths: string[],
): Promise<{ deleted: number; folders: { files: number; path: string }[] }> {
  const freed: (string | null)[] = [];
  const result = await db.transaction(async (tx) => {
    await lockPhotoLibrary(tx, accountId);
    await assertPhotosAvailable(tx, accountId);
    let deleted = 0;
    const folders: { files: number; path: string }[] = [];
    for (const path of outermostPaths(paths)) {
      const rows = await tx
        .delete(photoEntries)
        .where(and(eq(photoEntries.accountId, accountId), atOrBelow(photoEntries.path, path)))
        .returning({
          kind: photoEntries.kind,
          objectKey: photoEntries.objectKey,
          path: photoEntries.path,
          thumbObjectKey: photoEntries.thumbObjectKey,
        });
      if (rows.length === 0) {
        continue;
      }
      deleted += 1;
      for (const row of rows) {
        freed.push(row.objectKey, row.thumbObjectKey);
      }
      if (rows.some((row) => row.path === path && row.kind === "folder")) {
        folders.push({ files: rows.filter((row) => row.kind === "file").length, path });
      }
      await tx
        .delete(photoShares)
        .where(and(eq(photoShares.accountId, accountId), atOrBelow(photoShares.path, path)));
      await touchPhotoFolder(tx, accountId, photoParent(path));
    }
    return { deleted, folders };
  });
  await deletePhotoObjects(freed);
  return result;
}

// ---------------------------------------------------------------------------
// Share links

export type PhotoShareRow = {
  createdAt: Date;
  /** The frame the link was made for; null for the folder's general link. */
  frameId: string | null;
  /** When something last read through the link; null until then. */
  lastUsedAt: Date | null;
  /** A custom link's label; null for the general and per-frame links. */
  name: string | null;
  path: string;
  token: string;
};

const shareColumns = {
  createdAt: photoShares.createdAt,
  frameId: photoShares.frameId,
  lastUsedAt: photoShares.lastUsedAt,
  name: photoShares.name,
  path: photoShares.path,
  token: photoShares.token,
};

export const maxPhotoShareNameLength = 120;
/** One `last_used_at` write per link per minute, not one per photo fetched. */
const shareUseTouchMs = 60_000;

const shareTokenPattern = /^pk_[A-Za-z0-9_-]{32,128}$/;

export function isPhotoShareToken(value: string) {
  return shareTokenPattern.test(value);
}

/** `pk_` and 32 URL-safe random characters (192 bits). */
export function newPhotoShareToken() {
  return `pk_${randomBytes(24).toString("base64url")}`;
}

export function photoShareUrl(origin: string, token: string) {
  return `${origin}/api/photos/shared/${token}`;
}

export function photoShareJson(row: PhotoShareRow, origin: string) {
  return {
    created_at: seconds(row.createdAt),
    frame_id: row.frameId,
    last_used_at: row.lastUsedAt ? seconds(row.lastUsedAt) : null,
    name: row.name,
    path: row.path,
    token: row.token,
    url: photoShareUrl(origin, row.token),
  };
}

export async function listPhotoShares(
  db: FramesDatabase,
  accountId: string,
): Promise<PhotoShareRow[]> {
  const rows = await db.select(shareColumns).from(photoShares).where(eq(photoShares.accountId, accountId));
  // By folder: the general link, then the frames' own, then the custom ones.
  const rank = (row: PhotoShareRow) => (row.name !== null ? 2 : row.frameId !== null ? 1 : 0);
  return rows.sort(
    (a, b) =>
      comparePhotoPaths(a.path, b.path) || rank(a) - rank(b) || a.createdAt.getTime() - b.createdAt.getTime(),
  );
}

/** A new custom link to the folder, every time; `name` is its label. */
export async function createCustomPhotoShare(
  db: FramesDatabase,
  accountId: string,
  path: string,
  name: string,
): Promise<PhotoShareRow> {
  return db.transaction(async (tx) => {
    await lockPhotoLibrary(tx, accountId);
    await assertPhotosAvailable(tx, accountId);
    const row = await rowAt(tx, accountId, path);
    if (!row) {
      throw new PhotoError("not_found", 404);
    }
    if (row.kind !== "folder") {
      throw new PhotoError("not_a_folder", 400);
    }
    const [created] = await tx
      .insert(photoShares)
      .values({ accountId, name, path, token: newPhotoShareToken() })
      .returning(shareColumns);
    return created as PhotoShareRow;
  });
}

/**
 * The folder's link for `frameId` (its general link when null), made now
 * unless it already has one. A folder has one general link and one per
 * frame, so a frame's access can be withdrawn on its own. The caller has
 * checked that the frame is the account's.
 */
export async function createPhotoShare(
  db: FramesDatabase,
  accountId: string,
  path: string,
  frameId: string | null = null,
): Promise<{ created: boolean; share: PhotoShareRow }> {
  return db.transaction(async (tx) => {
    await lockPhotoLibrary(tx, accountId);
    await assertPhotosAvailable(tx, accountId);
    const row = await rowAt(tx, accountId, path);
    if (!row) {
      throw new PhotoError("not_found", 404);
    }
    if (row.kind !== "folder") {
      throw new PhotoError("not_a_folder", 400);
    }
    const [existing] = await tx
      .select(shareColumns)
      .from(photoShares)
      .where(
        and(
          eq(photoShares.accountId, accountId),
          eq(photoShares.path, path),
          frameId === null ? isNull(photoShares.frameId) : eq(photoShares.frameId, frameId),
          isNull(photoShares.name),
        ),
      )
      .orderBy(photoShares.createdAt)
      .limit(1);
    if (existing) {
      return { created: false, share: existing };
    }
    const [created] = await tx
      .insert(photoShares)
      .values({ accountId, frameId, path, token: newPhotoShareToken() })
      .returning(shareColumns);
    return { created: true, share: created as PhotoShareRow };
  });
}

export async function deletePhotoShare(
  db: FramesDatabase,
  accountId: string,
  token: string,
): Promise<PhotoShareRow | undefined> {
  const [deleted] = await db
    .delete(photoShares)
    .where(and(eq(photoShares.accountId, accountId), eq(photoShares.token, token)))
    .returning(shareColumns);
  return deleted;
}

export type ResolvedPhotoShare = { accountId: string; name: string; path: string; token: string };

/**
 * The link behind a token, or undefined for an unknown token, a deleted
 * folder or a suspended account (all three are a 404 to a frame).
 */
export async function resolvePhotoShare(
  db: FramesDatabase,
  token: string,
): Promise<ResolvedPhotoShare | undefined> {
  if (!isPhotoShareToken(token)) {
    return undefined;
  }
  const [share] = await db
    .select({
      accountId: photoShares.accountId,
      id: photoShares.id,
      lastUsedAt: photoShares.lastUsedAt,
      path: photoShares.path,
    })
    .from(photoShares)
    .innerJoin(accounts, eq(accounts.id, photoShares.accountId))
    .where(and(eq(photoShares.token, token), isNull(accounts.photosSuspendedAt)))
    .limit(1);
  if (!share) {
    return undefined;
  }
  const folder = await rowAt(db, share.accountId, share.path);
  if (!folder || folder.kind !== "folder") {
    return undefined;
  }
  // The owner's dialog says "last used 5 min ago" from this: moved once a
  // minute, so a frame's many fetches of one render cost one write.
  const now = Date.now();
  if (!share.lastUsedAt || now - share.lastUsedAt.getTime() >= shareUseTouchMs) {
    await db.update(photoShares).set({ lastUsedAt: new Date(now) }).where(eq(photoShares.id, share.id));
  }
  return { accountId: share.accountId, name: photoBasename(share.path), path: share.path, token };
}

export type SharedPhoto = {
  colors: PhotoColors | null;
  contentType: string | null;
  height: number | null;
  mtime: number;
  name: string;
  /** Relative to the shared folder. */
  path: string;
  size: number;
  width: number | null;
};

/**
 * Every playable file below the shared folder, by path (natural order), at
 * most `maxSharedPhotoFiles`. Also when the album last changed.
 *
 * `colors` (up to 64 KB a row) comes along only when asked: the listing
 * sends every file's, but /photo, called once per render per frame, picks
 * one file and reads that one's with sharedPhotoColors.
 */
export async function sharedPhotos(
  db: FramesDatabase,
  share: ResolvedPhotoShare,
  options: { withColors: boolean } = { withColors: true },
): Promise<{ photos: SharedPhoto[]; updatedAt: number }> {
  const rows = await db
    .select({
      colors: options.withColors ? photoEntries.colors : sql<null>`NULL`,
      contentType: photoEntries.contentType,
      createdAt: photoEntries.createdAt,
      height: photoEntries.height,
      kind: photoEntries.kind,
      path: photoEntries.path,
      sizeBytes: photoEntries.sizeBytes,
      status: photoEntries.status,
      updatedAt: photoEntries.updatedAt,
      width: photoEntries.width,
    })
    .from(photoEntries)
    .where(
      and(eq(photoEntries.accountId, share.accountId), atOrBelow(photoEntries.path, share.path)),
    );
  const prefix = `${share.path}/`;
  let updatedAt = 0;
  const photos: SharedPhoto[] = [];
  for (const row of rows) {
    updatedAt = Math.max(updatedAt, seconds(row.updatedAt));
    const name = photoBasename(row.path);
    if (row.kind !== "file" || row.status !== "ready" || !isPlayablePhotoName(name)) {
      continue;
    }
    photos.push({
      colors: row.colors ?? null,
      contentType: row.contentType,
      height: row.height,
      mtime: seconds(row.createdAt),
      name,
      path: row.path.slice(prefix.length),
      size: Number(row.sizeBytes),
      width: row.width,
    });
  }
  photos.sort((a, b) => comparePhotoPaths(a.path, b.path));
  return { photos: photos.slice(0, maxSharedPhotoFiles), updatedAt };
}

/** The color profile of one file below the shared folder, or null. */
export async function sharedPhotoColors(
  db: FramesDatabase,
  share: ResolvedPhotoShare,
  relative: string,
): Promise<PhotoColors | null> {
  const [row] = await db
    .select({ colors: photoEntries.colors })
    .from(photoEntries)
    .where(
      and(eq(photoEntries.accountId, share.accountId), eq(photoEntries.path, `${share.path}/${relative}`)),
    )
    .limit(1);
  return (row?.colors as PhotoColors | undefined) ?? null;
}

/**
 * One playable file below the shared folder by its path relative to it, or
 * undefined (a single-photo scene asks for its photo by path).
 */
export async function sharedPhotoAt(
  db: FramesDatabase,
  share: ResolvedPhotoShare,
  relative: string,
): Promise<SharedPhoto | undefined> {
  const name = photoBasename(relative);
  if (!isPlayablePhotoName(name) || parsePhotoPath(relative, { allowRoot: false }) === undefined) {
    return undefined;
  }
  const [row] = await db
    .select({
      colors: photoEntries.colors,
      contentType: photoEntries.contentType,
      createdAt: photoEntries.createdAt,
      height: photoEntries.height,
      kind: photoEntries.kind,
      sizeBytes: photoEntries.sizeBytes,
      status: photoEntries.status,
      width: photoEntries.width,
    })
    .from(photoEntries)
    .where(
      and(eq(photoEntries.accountId, share.accountId), eq(photoEntries.path, `${share.path}/${relative}`)),
    )
    .limit(1);
  if (!row || row.kind !== "file" || row.status !== "ready") {
    return undefined;
  }
  return {
    colors: (row.colors as PhotoColors | null) ?? null,
    contentType: row.contentType,
    height: row.height,
    mtime: seconds(row.createdAt),
    name,
    path: relative,
    size: Number(row.sizeBytes),
    width: row.width,
  };
}

/** One playable file below the shared folder (`relative` to it). */
export async function sharedPhotoObject(
  db: FramesDatabase,
  share: ResolvedPhotoShare,
  relative: string,
) {
  if (!isPlayablePhotoName(photoBasename(relative))) {
    return undefined;
  }
  const row = await photoFileObjects(db, share.accountId, `${share.path}/${relative}`);
  if (!row || row.status !== "ready" || !row.objectKey) {
    return undefined;
  }
  return row;
}

// ---------------------------------------------------------------------------
// Scanning bookkeeping

export async function blockedPhotoHash(
  db: FramesDatabase,
  sha256: string,
): Promise<{ reason: string | null } | undefined> {
  const [row] = await db
    .select({ reason: photoBlockedHashes.reason })
    .from(photoBlockedHashes)
    // Hash tools print either case; admins paste what they got.
    .where(sql`lower(${photoBlockedHashes.sha256}) = ${sha256.toLowerCase()}`)
    .limit(1);
  return row;
}

/**
 * A scan matched: keep the evidence, suspend the account's photos (uploads
 * refused, every share link 404) and tell the admins. Nothing of the image
 * is kept.
 */
export async function recordPhotoScanMatch(
  db: FramesDatabase,
  input: {
    accountId: string;
    clientIp: string | undefined;
    details: Record<string, unknown>;
    email: string | undefined;
    scanner: PhotoScanner;
    sha256: string;
  },
) {
  const [account] = await db
    .select({ email: accounts.primaryEmail })
    .from(accounts)
    .where(eq(accounts.id, input.accountId))
    .limit(1);
  const email = account?.email ?? input.email ?? null;
  await db.transaction(async (tx) => {
    await tx.insert(photoScanHits).values({
      accountEmail: email,
      accountId: input.accountId,
      clientIp: input.clientIp ?? null,
      details: input.details,
      scanner: input.scanner,
      sha256: input.sha256,
    });
    await tx
      .update(accounts)
      .set({ photosSuspendedAt: new Date() })
      .where(and(eq(accounts.id, input.accountId), isNull(accounts.photosSuspendedAt)));
  });

  const adminUrl = new URL("/admin/photos", getAccountBaseUrl()).toString();
  await Promise.all([
    capturePostHogEvent("photo scan matched", input.accountId, {
      admin_url: adminUrl,
      scanner: input.scanner,
      sha256: input.sha256,
    }),
    notifyDiscord(
      [
        `**Photo scan match** (${input.scanner})`,
        `Account: ${email ?? input.accountId}`,
        `SHA-256: ${input.sha256}`,
        "The upload was refused and the account's photos are suspended.",
        `Review: <${adminUrl}>`,
      ].join("\n"),
    ),
  ]);
}

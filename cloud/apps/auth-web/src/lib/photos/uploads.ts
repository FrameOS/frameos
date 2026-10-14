// Unfinished photo uploads (POST /api/photos/upload, the chunk protocol).
//
// Chunks are held on THIS host's disk, never in the object store: the bucket
// is public through its CDN alias, and nothing may land there before the
// finished file has passed the scan. One file per upload, appended chunk by
// chunk; its size is how many bytes the server has, which is what the 409
// rule compares against. A chunk that does not start where the file ends
// (the process restarted, a blue/green deploy moved traffic to the other
// instance, whose PrivateTmp is its own, or the hour ran out) answers 409 and
// the client starts over under a new id: the protocol is built for exactly
// that, so a shared store would buy nothing.
//
// Files older than an hour are dropped (docs/photos.md): on every new
// upload at most once per ten minutes, whenever a chunk finds its own file
// stale, and every ten minutes by a timer once this module is loaded, so a
// burst that stops still gets cleaned up.

import { mkdir, readdir, readFile, rm, rmdir, stat, appendFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const photoUploadTtlMs = 60 * 60 * 1000;
// How many unfinished uploads one account may hold at once. A browser sends
// a few files in parallel; a few dozen parked 20 MiB uploads would only fill
// the disk.
export const maxPendingPhotoUploadsPerAccount = 16;
// And across all accounts, in bytes: the parked chunks share one disk.
export const maxPendingPhotoUploadBytes = 2 * 1024 * 1024 * 1024;

const sweepEveryMs = 10 * 60 * 1000;
let lastSweepAt = 0;

const uploadIdPattern = /^[A-Za-z0-9_-]{8,64}$/;
const accountIdPattern = /^[0-9a-f-]{36}$/i;

export function isValidPhotoUploadId(value: unknown): value is string {
  return typeof value === "string" && uploadIdPattern.test(value);
}

export function photoUploadDirectory(): string {
  const configured = process.env.FRAMEOS_PHOTO_UPLOAD_DIR?.trim();
  return resolve(configured || join(tmpdir(), "frameos-cloud-photo-uploads"));
}

function accountDirectory(accountId: string) {
  if (!accountIdPattern.test(accountId)) {
    throw new Error(`Invalid account id for an upload path: ${JSON.stringify(accountId)}`);
  }
  return join(photoUploadDirectory(), accountId.toLowerCase());
}

function uploadFile(accountId: string, uploadId: string) {
  if (!isValidPhotoUploadId(uploadId)) {
    throw new Error(`Invalid upload id: ${JSON.stringify(uploadId)}`);
  }
  return join(accountDirectory(accountId), `${uploadId}.part`);
}

async function fileState(path: string): Promise<{ mtimeMs: number; size: number } | undefined> {
  try {
    const info = await stat(path);
    return { mtimeMs: info.mtimeMs, size: info.size };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export type ChunkResult =
  | { ok: true; received: number }
  | { error: "chunk_gap"; ok: false; received: number }
  | { error: "too_many_uploads"; ok: false };

/**
 * Write `bytes` at `offset` of the upload. Offset 0 (re)starts it; any other
 * offset must be exactly where the held bytes end.
 */
export async function writePhotoUploadChunk(
  accountId: string,
  uploadId: string,
  offset: number,
  bytes: Uint8Array,
  now = Date.now(),
): Promise<ChunkResult> {
  const path = uploadFile(accountId, uploadId);
  const existing = await fileState(path);
  const fresh = existing && now - existing.mtimeMs <= photoUploadTtlMs ? existing : undefined;
  if (existing && !fresh) {
    await rm(path, { force: true });
  }

  if (offset === 0) {
    if (!fresh) {
      await sweepStalePhotoUploads(now);
      if ((await pendingPhotoUploadCount(accountId, now)) >= maxPendingPhotoUploadsPerAccount) {
        return { error: "too_many_uploads", ok: false };
      }
      if ((await pendingPhotoUploadBytes(now)) >= maxPendingPhotoUploadBytes) {
        return { error: "too_many_uploads", ok: false };
      }
    }
    await mkdir(accountDirectory(accountId), { recursive: true });
    await writeFile(path, bytes);
    return { ok: true, received: bytes.length };
  }

  const held = fresh?.size ?? 0;
  if (!fresh || held !== offset) {
    return { error: "chunk_gap", ok: false, received: held };
  }
  await appendFile(path, bytes);
  return { ok: true, received: offset + bytes.length };
}

/** The bytes held so far (the whole file once the last chunk is in). */
export async function readPhotoUpload(
  accountId: string,
  uploadId: string,
): Promise<Buffer | undefined> {
  try {
    return await readFile(uploadFile(accountId, uploadId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export async function discardPhotoUpload(accountId: string, uploadId: string): Promise<void> {
  await rm(uploadFile(accountId, uploadId), { force: true });
}

/** The account's unfinished uploads that are still within the hour. */
export async function pendingPhotoUploadCount(accountId: string, now = Date.now()) {
  let names: string[];
  try {
    names = await readdir(accountDirectory(accountId));
  } catch {
    return 0;
  }
  let count = 0;
  for (const name of names) {
    const state = await fileState(join(accountDirectory(accountId), name)).catch(() => undefined);
    if (state && now - state.mtimeMs <= photoUploadTtlMs) {
      count += 1;
    }
  }
  return count;
}

/** Every parked file, across all accounts, with whether it is within the hour. */
async function* parkedFiles(now: number) {
  const root = photoUploadDirectory();
  let accounts: string[];
  try {
    accounts = await readdir(root);
  } catch {
    return;
  }
  for (const account of accounts) {
    const directory = join(root, account);
    let names: string[];
    try {
      names = await readdir(directory);
    } catch {
      continue;
    }
    for (const name of names) {
      const path = join(directory, name);
      const state = await fileState(path).catch(() => undefined);
      if (state) {
        yield { fresh: now - state.mtimeMs <= photoUploadTtlMs, path, size: state.size };
      }
    }
    // Only succeeds when the directory is empty, which is the point.
    await rmdir(directory).catch(() => undefined);
  }
}

/** The bytes parked across all accounts, within the hour. */
export async function pendingPhotoUploadBytes(now = Date.now()) {
  let total = 0;
  for await (const file of parkedFiles(now)) {
    if (file.fresh) {
      total += file.size;
    }
  }
  return total;
}

/** Drop every upload older than the hour, across all accounts. */
export async function sweepStalePhotoUploads(now = Date.now(), force = false): Promise<void> {
  if (!force && now - lastSweepAt < sweepEveryMs) {
    return;
  }
  lastSweepAt = now;
  for await (const file of parkedFiles(now)) {
    if (!file.fresh) {
      await rm(file.path, { force: true }).catch(() => undefined);
    }
  }
}

// The timer never keeps the process alive, and a sweep that fails (the
// directory is gone) says nothing: the next chunk will.
if (process.env.NODE_ENV === "production") {
  setInterval(() => {
    sweepStalePhotoUploads(Date.now(), true).catch(() => undefined);
  }, sweepEveryMs).unref();
}

import { mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  discardPhotoUpload,
  isValidPhotoUploadId,
  maxPendingPhotoUploadsPerAccount,
  pendingPhotoUploadBytes,
  pendingPhotoUploadCount,
  photoUploadDirectory,
  readPhotoUpload,
  sweepStalePhotoUploads,
  writePhotoUploadChunk,
} from "./uploads";

const account = "0b6f4c1e-8d1f-4a57-9c0e-3f6a2b1d4e5f";
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "frameos-photo-uploads-test-"));
  vi.stubEnv("FRAMEOS_PHOTO_UPLOAD_DIR", root);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { force: true, recursive: true });
});

describe("photo upload chunks", () => {
  it("validates upload ids like the contract says", () => {
    expect(isValidPhotoUploadId("abcd1234")).toBe(true);
    expect(isValidPhotoUploadId("a".repeat(64))).toBe(true);
    expect(isValidPhotoUploadId("short")).toBe(false);
    expect(isValidPhotoUploadId("a".repeat(65))).toBe(false);
    expect(isValidPhotoUploadId("../../etc")).toBe(false);
    expect(isValidPhotoUploadId(undefined)).toBe(false);
  });

  it("appends chunks that start where the last one ended", async () => {
    expect(photoUploadDirectory()).toBe(root);
    expect(await writePhotoUploadChunk(account, "upload-1", 0, Buffer.from("abc"))).toEqual({
      ok: true,
      received: 3,
    });
    expect(await writePhotoUploadChunk(account, "upload-1", 3, Buffer.from("def"))).toEqual({
      ok: true,
      received: 6,
    });
    expect((await readPhotoUpload(account, "upload-1"))?.toString()).toBe("abcdef");
    await discardPhotoUpload(account, "upload-1");
    expect(await readPhotoUpload(account, "upload-1")).toBeUndefined();
  });

  it("answers a gap (or an unknown upload) with what it holds", async () => {
    expect(await writePhotoUploadChunk(account, "upload-2", 5, Buffer.from("x"))).toEqual({
      error: "chunk_gap",
      ok: false,
      received: 0,
    });
    await writePhotoUploadChunk(account, "upload-2", 0, Buffer.from("abc"));
    expect(await writePhotoUploadChunk(account, "upload-2", 4, Buffer.from("x"))).toEqual({
      error: "chunk_gap",
      ok: false,
      received: 3,
    });
    // Offset 0 starts the upload over.
    expect(await writePhotoUploadChunk(account, "upload-2", 0, Buffer.from("z"))).toEqual({
      ok: true,
      received: 1,
    });
  });

  it("drops an upload untouched for an hour", async () => {
    await writePhotoUploadChunk(account, "upload-3", 0, Buffer.from("abc"));
    const path = join(root, account, "upload-3.part");
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(path, old, old);
    expect(await writePhotoUploadChunk(account, "upload-3", 3, Buffer.from("def"))).toEqual({
      error: "chunk_gap",
      ok: false,
      received: 0,
    });
    expect(await readPhotoUpload(account, "upload-3")).toBeUndefined();

    await writePhotoUploadChunk(account, "upload-4", 0, Buffer.from("abc"));
    await utimes(join(root, account, "upload-4.part"), old, old);
    await sweepStalePhotoUploads(Date.now(), true);
    expect(await readPhotoUpload(account, "upload-4")).toBeUndefined();
  });

  it("caps how many unfinished uploads one account holds", async () => {
    for (let index = 0; index < maxPendingPhotoUploadsPerAccount; index += 1) {
      expect(
        (await writePhotoUploadChunk(account, `parallel-${index}`, 0, Buffer.from("a"))).ok,
      ).toBe(true);
    }
    expect(await pendingPhotoUploadCount(account)).toBe(maxPendingPhotoUploadsPerAccount);
    expect(await writePhotoUploadChunk(account, "one-too-many", 0, Buffer.from("a"))).toEqual({
      error: "too_many_uploads",
      ok: false,
    });
    // Restarting one already held is not a new upload.
    expect((await writePhotoUploadChunk(account, "parallel-0", 0, Buffer.from("b"))).ok).toBe(
      true,
    );
  });

  it("counts the bytes parked across accounts, within the hour", async () => {
    const other = "1c7e5d2f-9e2a-4b68-8d1f-4a7b3c2d5e6f";
    await writePhotoUploadChunk(account, "mine-0001", 0, Buffer.alloc(10));
    await writePhotoUploadChunk(account, "mine-0001", 10, Buffer.alloc(5));
    await writePhotoUploadChunk(other, "theirs-0001", 0, Buffer.alloc(7));
    expect(await pendingPhotoUploadBytes()).toBe(22);
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(join(root, other, "theirs-0001.part"), old, old);
    expect(await pendingPhotoUploadBytes()).toBe(15);
  });

  it("refuses ids and accounts that are not safe path components", async () => {
    await expect(writePhotoUploadChunk("../x", "upload-5", 0, Buffer.from("a"))).rejects.toThrow();
    await expect(writePhotoUploadChunk(account, "../../x", 0, Buffer.from("a"))).rejects.toThrow();
  });
});

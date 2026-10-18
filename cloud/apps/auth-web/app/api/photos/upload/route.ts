import { NextRequest, NextResponse } from "next/server";
import { detectImageContentType } from "../../../../src/lib/store";
import { jsonError, readBoundedBytes } from "../../../../src/lib/device-flow";
import { logWarn } from "../../../../src/lib/log";
import { photoOwnerContext, withPhotoErrors } from "../../../../src/lib/photos/http";
import { imageDimensions } from "../../../../src/lib/photos/image-info";
import { scanIncomingPhoto } from "../../../../src/lib/photos/intake";
import {
  type PhotoMetadata,
  readPhotoMetadataBytes,
  readPhotoMetadataFile,
} from "../../../../src/lib/photos/metadata";
import {
  acceptedPhotoContentTypes,
  assertPhotoQuota,
  maxPhotoChunkBytes,
  maxPhotoUploadBytes,
  storePhotoFile,
} from "../../../../src/lib/photos/library";
import {
  isValidPhotoSegment,
  joinPhotoPath,
  parsePhotoPath,
  photoPathWithinLimits,
} from "../../../../src/lib/photos/paths";
import { makePhotoThumbnail } from "../../../../src/lib/photos/thumbnail";
import {
  type PhotoUploadFile,
  discardPhotoUpload,
  isValidPhotoUploadId,
  photoUploadFile,
  readPhotoUploadHead,
  writePhotoUploadChunk,
} from "../../../../src/lib/photos/uploads";

export const runtime = "nodejs";

// POST /api/photos/upload?path=<folder>&filename=<name>&upload_id=<id>
//   &offset=<n>&complete=0|1, raw body (docs/photos.md).
//
// Chunks wait on this host's disk (src/lib/photos/uploads.ts). Nothing
// reaches the object store until the whole file is in, is one of the four
// accepted image types (sniffed), fits the quota and has passed every
// configured scanner. It is stored exactly as sent; its thumbnail is made
// here (src/lib/photos/thumbnail.ts) and its metadata read into the row
// (src/lib/photos/metadata.ts, docs/photos.md "Metadata"). A chunked file is
// worked on where it lies: hashed, scanned, read, thumbnailed and streamed
// to the store from disk, so a 250 MiB photo is never one buffer in this
// process.
export async function POST(request: NextRequest) {
  const context = await photoOwnerContext(request, { kind: "upload" });
  if (context.response) {
    return context.response;
  }
  const { accountId, db, email } = context;
  const query = request.nextUrl.searchParams;

  const uploadId = query.get("upload_id");
  if (!isValidPhotoUploadId(uploadId)) {
    return jsonError("invalid_upload_id", 400);
  }
  const folder = parsePhotoPath(query.get("path") ?? "", { allowRoot: true });
  if (folder === undefined) {
    return jsonError("invalid_path", 400);
  }
  const filename = query.get("filename") ?? "";
  if (!isValidPhotoSegment(filename) || !photoPathWithinLimits(joinPhotoPath(folder, filename))) {
    return jsonError("invalid_path", 400);
  }
  const offset = Number(query.get("offset") ?? "0");
  if (!Number.isSafeInteger(offset) || offset < 0) {
    return jsonError("invalid_offset", 400);
  }
  // Like the backend: a request without the flag is a whole file.
  const complete = ["1", "true"].includes((query.get("complete") ?? "1").toLowerCase());
  if (offset >= maxPhotoUploadBytes) {
    await discardPhotoUpload(accountId, uploadId);
    return jsonError("too_large", 413, { max_bytes: maxPhotoUploadBytes });
  }

  const body = await readBoundedBytes(request, maxPhotoChunkBytes);
  if (!body) {
    return jsonError("invalid_body", 400);
  }
  if (body.overflow) {
    return jsonError("chunk_too_large", 413, { max_bytes: maxPhotoChunkBytes });
  }
  const chunk = body.bytes;
  if (chunk.length === 0 && !complete) {
    return jsonError("file_empty", 400);
  }
  if (offset + chunk.length > maxPhotoUploadBytes) {
    await discardPhotoUpload(accountId, uploadId);
    return jsonError("too_large", 413, { max_bytes: maxPhotoUploadBytes });
  }

  return withPhotoErrors(async () => {
    // The first chunk carries the header: refuse a type we will never store
    // before the client sends the rest of it.
    if (offset === 0 && chunk.length >= 12 && !acceptedType(chunk)) {
      await discardPhotoUpload(accountId, uploadId);
      return unsupportedType();
    }
    // Cheap early refusal; the real check runs again under the lock.
    await assertPhotoQuota(db, accountId, offset + chunk.length);

    let file: Buffer | PhotoUploadFile;
    if (offset === 0 && complete) {
      // A file in one request never touches the disk.
      file = chunk;
    } else {
      const written = await writePhotoUploadChunk(accountId, uploadId, offset, chunk);
      if (!written.ok) {
        if (written.error === "too_many_uploads") {
          return jsonError("too_many_uploads", 429, {
            message: "Too many uploads at once. Wait for some to finish.",
          });
        }
        return jsonError("chunk_gap", 409, { received: written.received });
      }
      if (!complete) {
        return NextResponse.json({ pending: true, received: written.received });
      }
      const held = await photoUploadFile(accountId, uploadId);
      if (!held) {
        return jsonError("chunk_gap", 409, { received: 0 });
      }
      file = held;
    }

    try {
      return await storeFinished(file, folder);
    } finally {
      if (!Buffer.isBuffer(file)) {
        await discardPhotoUpload(accountId, uploadId);
      }
    }
  });

  async function storeFinished(file: Buffer | PhotoUploadFile, folder: string) {
    const size = Buffer.isBuffer(file) ? file.length : file.size;
    if (size === 0) {
      return jsonError("file_empty", 400);
    }
    // The header is all a sniff and a size read need; a JPEG's frame header
    // sits after its EXIF, XMP and ICC segments, well inside one chunk.
    const head = Buffer.isBuffer(file) ? file : await readPhotoUploadHead(file, maxPhotoChunkBytes);
    const contentType = acceptedType(head);
    if (!contentType) {
      return unsupportedType();
    }
    await assertPhotoQuota(db, accountId, size);

    const source = Buffer.isBuffer(file) ? file : file.path;
    const scanned = await scanIncomingPhoto(db, request, { accountId, email }, source, contentType);
    if (scanned.response) {
      return scanned.response;
    }
    const dimensions = imageDimensions(head, contentType);
    const thumbnail = await makePhotoThumbnail(source);
    const metadata = await readMetadata(file);
    const entry = await storePhotoFile(db, accountId, {
      body: file,
      size,
      contentType,
      folder,
      height: dimensions?.height ?? null,
      metadata,
      name: filename,
      sha256: scanned.sha256,
      thumbnail,
      width: dimensions?.width ?? null,
    });
    return NextResponse.json({ entry });
  }
}

/**
 * What the photo carries, read at offsets from the file on disk. A read that
 * fails stores nothing (null: the folder listing reads it later); an upload
 * is never refused for its metadata.
 */
async function readMetadata(file: Buffer | PhotoUploadFile): Promise<PhotoMetadata | null> {
  try {
    return Buffer.isBuffer(file) ? await readPhotoMetadataBytes(file) : await readPhotoMetadataFile(file);
  } catch (error) {
    logWarn("photos.metadata_read_failed", { error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

function acceptedType(bytes: Buffer): string | undefined {
  const sniffed = detectImageContentType(bytes);
  return sniffed && (acceptedPhotoContentTypes as readonly string[]).includes(sniffed)
    ? sniffed
    : undefined;
}

function unsupportedType() {
  return jsonError("unsupported_type", 415, {
    accepts: [...acceptedPhotoContentTypes],
    message: "Only JPEG, PNG, GIF and WebP images can be stored.",
  });
}

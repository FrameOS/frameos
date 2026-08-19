import { NextRequest, NextResponse } from "next/server";
import { jsonError } from "../../../../../../src/lib/device-flow";
import { normalizeAssetPath } from "../../../../../../src/lib/frame-asset-cache";
import {
  assetUploadChunkBytes,
  assetWriteErrorResponse,
  assetWriteRequestContext,
  hiddenWritePath,
  invalidateCachedAssetSubtree,
  isValidUploadId,
  maxChunkedAssetUploadBytes,
  putAssetChunk,
  queueAssetsListRefresh,
  recordAssetWriteAudit,
  sanitizedUploadFilename,
  uploadAssetBytes,
} from "../../../../../../src/lib/frame-asset-write";

export const runtime = "nodejs";

// Upload one file into the frame's assets directory, in either of the two
// shapes the shared SPA's Assets panel speaks against the self-hosted
// backend:
//
//  - multipart FormData{file, path}: the whole file in one request. Small
//    files ride a single asset_put; bigger ones are cut into asset_put_chunk
//    commands here, each acked by the device before the next goes out.
//  - the chunk protocol (uploadFileInChunks): raw body per chunk, with
//    ?upload_id=&offset=&complete=&filename=&path= — one asset_put_chunk per
//    request, so no single HTTP request has to outlive a slow SD-card write of
//    a 60 MB file, and the panel's progress bar tracks what the device really
//    has. 409 tells the SPA the device lost earlier bytes (restart the file);
//    a non-final chunk answers {pending: true}, the final one the stored entry.
//
// The device is the size authority (docs/cloud-frames.md `asset_put_chunk`);
// the caps here only spare it commands it would refuse.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ frameId: string }> },
) {
  const { frameId } = await params;
  const context = await assetWriteRequestContext(request, frameId);
  if (context.response) {
    return context.response;
  }
  const { db, accountId, frame } = context;

  if (request.nextUrl.searchParams.has("upload_id")) {
    return uploadChunk(request, context);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return jsonError("invalid_form", 400);
  }
  const file = form.get("file");
  if (!(file instanceof File)) {
    return jsonError("file_required", 400);
  }
  if (file.size === 0) {
    return jsonError("file_empty", 400);
  }
  if (file.size > maxChunkedAssetUploadBytes) {
    return jsonError("too_large", 413, { max_bytes: maxChunkedAssetUploadBytes });
  }
  const target = resolveTargetPath(String(form.get("path") ?? ""), file.name ?? "");
  if (!target) {
    return jsonError("invalid_path", 400);
  }

  const result = await uploadAssetBytes(
    db,
    accountId,
    frame,
    target,
    new Uint8Array(await file.arrayBuffer()),
  );
  if (!result.ok) {
    return uploadErrorResponse(result);
  }
  await invalidateCachedAssetSubtree(db, frame.id, target);
  await queueAssetsListRefresh(db, accountId, frame.id);
  await recordAssetWriteAudit(db, context, "frame.asset_uploaded", {
    bytes: file.size,
    path: target,
  });
  return NextResponse.json(storedEntry(target, file.size));
}

type UploadContext = Exclude<
  Awaited<ReturnType<typeof assetWriteRequestContext>>,
  { response: Response }
>;

async function uploadChunk(request: NextRequest, context: UploadContext) {
  const { db, accountId, frame } = context;
  const query = request.nextUrl.searchParams;
  const uploadId = query.get("upload_id");
  if (!isValidUploadId(uploadId)) {
    return jsonError("invalid_upload_id", 400);
  }
  const offset = Number(query.get("offset") ?? "0");
  if (!Number.isInteger(offset) || offset < 0) {
    return jsonError("invalid_offset", 400);
  }
  const complete = query.get("complete") === "1" || query.get("complete") === "true";
  const target = resolveTargetPath(query.get("path") ?? "", query.get("filename") ?? "");
  if (!target) {
    return jsonError("invalid_path", 400);
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length === 0) {
    return jsonError("file_empty", 400);
  }
  // Per-chunk cap: what the device takes in one WS frame (256 KiB raw on an
  // ESP32, 1 MiB on Linux). The SPA picks the same sizes; a client that sends
  // more learns the limit rather than watching the device refuse it.
  const chunkCap = assetUploadChunkBytes(frame);
  if (bytes.length > chunkCap) {
    return jsonError("chunk_too_large", 413, { max_bytes: chunkCap });
  }
  if (offset + bytes.length > maxChunkedAssetUploadBytes) {
    return jsonError("too_large", 413, { max_bytes: maxChunkedAssetUploadBytes });
  }

  const result = await putAssetChunk(db, accountId, frame.id, {
    uploadId,
    offset,
    bytes,
    ...(complete ? { finalPath: target } : {}),
  });
  if (!result.ok) {
    return uploadErrorResponse(result);
  }
  if (!complete) {
    return NextResponse.json({ pending: true, received: offset + bytes.length });
  }
  await invalidateCachedAssetSubtree(db, frame.id, target);
  await queueAssetsListRefresh(db, accountId, frame.id);
  await recordAssetWriteAudit(db, context, "frame.asset_uploaded", {
    bytes: offset + bytes.length,
    chunked: true,
    path: target,
  });
  return NextResponse.json(storedEntry(target, offset + bytes.length));
}

/** `<subdir>/<sanitized filename>`, or undefined for a path the device refuses. */
function resolveTargetPath(rawSubdir: string, filename: string): string | undefined {
  let subdir = "";
  if (rawSubdir.trim().length > 0) {
    const normalized = normalizeAssetPath(rawSubdir.trim());
    if (!normalized) {
      return undefined;
    }
    subdir = normalized;
  }
  const safeFilename = sanitizedUploadFilename(filename);
  const target = subdir ? `${subdir}/${safeFilename}` : safeFilename;
  return hiddenWritePath(target) ? undefined : target;
}

/** The entry the SPA expects back — predicted, since the ack's payload does
 * not survive into frame_commands. */
function storedEntry(path: string, size: number) {
  return {
    is_dir: false,
    mtime: Math.floor(Date.now() / 1000),
    path,
    size,
  };
}

function uploadErrorResponse(result: { ok: false; error: string; timedOut?: boolean }) {
  if (result.error === "chunked_upload_unsupported") {
    // Firmware from before asset_put_chunk: only single-frame files fit.
    return jsonError("chunked_upload_unsupported", 400, {
      message:
        "This frame's FrameOS is too old to receive files larger than 2.5 MB — update it first.",
    });
  }
  return assetWriteErrorResponse(result);
}

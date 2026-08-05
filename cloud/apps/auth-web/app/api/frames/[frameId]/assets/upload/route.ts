import { NextRequest, NextResponse } from "next/server";
import { jsonError } from "../../../../../../src/lib/device-flow";
import { normalizeAssetPath } from "../../../../../../src/lib/frame-asset-cache";
import {
  assetWriteErrorResponse,
  assetWriteRequestContext,
  hiddenWritePath,
  invalidateCachedAssetSubtree,
  maxAssetUploadBytes,
  queueAssetsListRefresh,
  runAssetWriteCommand,
  sanitizedUploadFilename,
} from "../../../../../../src/lib/frame-asset-write";

export const runtime = "nodejs";

// Upload one file into the frame's assets directory — the multipart contract
// the shared SPA's uploadDroppedFiles already speaks against the self-hosted
// backend (FormData{file, path}), answered with the stored entry. The bytes
// ride an asset_put command (base64 in a single WS frame), so the size cap is
// far below the backend's: files past it need a chunked verb that does not
// exist yet, and the error says so instead of stalling.
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
  if (file.size > maxAssetUploadBytes) {
    return jsonError("too_large", 413, { max_bytes: maxAssetUploadBytes });
  }
  const rawSubdir = String(form.get("path") ?? "").trim();
  let subdir = "";
  if (rawSubdir.length > 0) {
    const normalized = normalizeAssetPath(rawSubdir);
    if (!normalized) {
      return jsonError("invalid_path", 400);
    }
    subdir = normalized;
  }
  const filename = sanitizedUploadFilename(file.name ?? "");
  const targetPath = subdir ? `${subdir}/${filename}` : filename;
  if (hiddenWritePath(targetPath)) {
    return jsonError("invalid_path", 400);
  }

  const data = Buffer.from(await file.arrayBuffer()).toString("base64");
  const result = await runAssetWriteCommand(db, accountId, frame.id, "asset_put", {
    data,
    path: targetPath,
  });
  if (!result.ok) {
    return assetWriteErrorResponse(result);
  }
  await invalidateCachedAssetSubtree(db, frame.id, targetPath);
  await queueAssetsListRefresh(db, accountId, frame.id);
  return NextResponse.json({
    is_dir: false,
    mtime: Math.floor(Date.now() / 1000),
    path: targetPath,
    size: file.size,
  });
}

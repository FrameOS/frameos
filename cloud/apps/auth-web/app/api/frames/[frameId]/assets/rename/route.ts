import { NextRequest, NextResponse } from "next/server";
import { jsonError } from "../../../../../../src/lib/device-flow";
import { normalizeAssetPath } from "../../../../../../src/lib/frame-asset-cache";
import {
  assetWriteErrorResponse,
  assetWriteRequestContext,
  hiddenWritePath,
  invalidateCachedAssetSubtree,
  queueAssetsListRefresh,
  recordAssetWriteAudit,
  runAssetWriteCommand,
} from "../../../../../../src/lib/frame-asset-write";

export const runtime = "nodejs";

// Rename/move a file or folder under the frame's assets directory —
// form-urlencoded `src` + `dst`, `{message}` back, same as the backend.
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
  const src = normalizeAssetPath(String(form.get("src") ?? ""));
  const dst = normalizeAssetPath(String(form.get("dst") ?? ""));
  if (!src || !dst || hiddenWritePath(src) || hiddenWritePath(dst)) {
    return jsonError("invalid_path", 400);
  }

  const result = await runAssetWriteCommand(
    db,
    accountId,
    frame.id,
    "asset_rename",
    { dst, src },
  );
  if (!result.ok) {
    return assetWriteErrorResponse(result);
  }
  // Both sides go: the src subtree is gone from the device, and any stale
  // rows under dst (a rename onto a previously cached path) are wrong now.
  await invalidateCachedAssetSubtree(db, frame.id, src);
  await invalidateCachedAssetSubtree(db, frame.id, dst);
  await queueAssetsListRefresh(db, accountId, frame.id);
  await recordAssetWriteAudit(db, context, "frame.asset_renamed", { dst, src });
  return NextResponse.json({ message: "Renamed" });
}

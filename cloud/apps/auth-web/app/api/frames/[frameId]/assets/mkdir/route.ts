import { NextRequest, NextResponse } from "next/server";
import { jsonError } from "../../../../../../src/lib/device-flow";
import { normalizeAssetPath } from "../../../../../../src/lib/frame-asset-cache";
import {
  assetWriteErrorResponse,
  assetWriteRequestContext,
  hiddenWritePath,
  queueAssetsListRefresh,
  runAssetWriteCommand,
} from "../../../../../../src/lib/frame-asset-write";

export const runtime = "nodejs";

// Create a folder under the frame's assets directory — form-urlencoded
// `path`, `{message}` back, same as the self-hosted backend's mkdir.
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
  const path = normalizeAssetPath(String(form.get("path") ?? ""));
  if (!path || hiddenWritePath(path)) {
    return jsonError("invalid_path", 400);
  }

  const result = await runAssetWriteCommand(
    db,
    accountId,
    frame.id,
    "asset_mkdir",
    { path },
  );
  if (!result.ok) {
    return assetWriteErrorResponse(result);
  }
  await queueAssetsListRefresh(db, accountId, frame.id);
  return NextResponse.json({ message: "Created" });
}

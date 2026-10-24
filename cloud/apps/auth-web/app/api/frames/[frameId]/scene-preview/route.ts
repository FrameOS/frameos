import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireDatabase } from "../../../../../src/lib/device-flow";
import { csrfResponse } from "../../../../../src/lib/csrf";
import { discardScenePreview, frameForAccount, scenePreviewScene } from "../../../../../src/lib/frames";
import { rateLimitResponse } from "../../../../../src/lib/rate-limit";
import { readSession } from "../../../../../src/lib/session";

export const runtime = "nodejs";

// The scene the frame shows for now (frame.scene_preview: the editor's
// "Preview on frame", the voice chat's picture), with its runtime JSON, for
// the preview row's "Install": the workspace adds it to the frame's scene
// list and pushes — persistAndPushCloudFrameScenes mints the private store
// scene — so it stays. 404 when the frame shows no preview. The same route
// exists on the self-hosted backend (/api/frames/{id}/scene_preview).
export async function GET(request: NextRequest, { params }: { params: Promise<{ frameId: string }> }) {
  const limited = await rateLimitResponse(request, "frames:read", {
    limit: 600,
    windowMs: 15 * 60 * 1000,
  });
  if (limited) {
    return limited;
  }
  const session = await readSession();
  if (!session?.accountId) {
    return jsonError("login_required", 401);
  }
  const { db, response } = requireDatabase();
  if (!db) {
    return response;
  }
  const { frameId } = await params;
  const frame = await frameForAccount(db, session.accountId, frameId);
  if (!frame) {
    return jsonError("invalid_frame", 404);
  }
  const preview = await scenePreviewScene(db, frame.id);
  if (!preview) {
    return jsonError("no_preview", 404);
  }
  return NextResponse.json(preview);
}

// The preview row's "Discard": the preview is over, so the push of the
// assigned list the workspace queues right after carries nothing and the
// frame goes back to its scenes (a push otherwise carries the preview along,
// docs/scene-previews.md). 404 when the frame shows no preview. The same
// route exists on the self-hosted backend (DELETE /api/frames/{id}/scene_preview).
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ frameId: string }> }) {
  const csrf = csrfResponse(request);
  if (csrf) {
    return csrf;
  }
  const limited = await rateLimitResponse(request, "frames:scenes", {
    limit: 240,
    windowMs: 15 * 60 * 1000,
  });
  if (limited) {
    return limited;
  }
  const session = await readSession();
  if (!session?.accountId) {
    return jsonError("login_required", 401);
  }
  const { db, response } = requireDatabase();
  if (!db) {
    return response;
  }
  const { frameId } = await params;
  const frame = await frameForAccount(db, session.accountId, frameId);
  if (!frame) {
    return jsonError("invalid_frame", 404);
  }
  if (!(await discardScenePreview(db, frame.id))) {
    return jsonError("no_preview", 404);
  }
  return NextResponse.json({ status: "discarded" });
}

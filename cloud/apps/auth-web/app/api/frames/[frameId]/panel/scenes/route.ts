import { NextRequest, NextResponse } from "next/server";
import {
  jsonError,
  readJsonObject,
  requireDatabase,
} from "../../../../../../src/lib/device-flow";
import { authenticateFrameDevice } from "../../../../../../src/lib/frame-device-auth";
import { runPanelSceneAction } from "../../../../../../src/lib/panel-scenes";
import { identityRateLimitResponse } from "../../../../../../src/lib/rate-limit";

export const runtime = "nodejs";

// A scene change asked on the frame's own screen (docs/scene-store-on-frame.md):
// the scene switcher's store page and the long press on a scene. The DEVICE
// calls this with its enrollment token, like the voice route; the frame in
// the path must be the token's. Body: {"action": "install" | "preview" |
// "update" | "remove" | "discard", "scene_id": "<store scene uuid>"} (for
// "discard", the runtime id to go back to). What each does, and what a frame
// may not do that its owner may, is panel-scenes.ts. The answer is
// {"ok": true, "status": "queued" | "up_to_date", …} or {"ok": false,
// "error": …}; the push that follows is the frame's to apply.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ frameId: string }> },
) {
  const { db, response } = requireDatabase();
  if (!db) {
    return response;
  }
  const auth = await authenticateFrameDevice(db, request.headers.get("authorization"));
  if ("response" in auth) {
    return auth.response;
  }
  const { frameId } = await params;
  if (auth.frame.id !== frameId) {
    return jsonError("frame_mismatch", 403);
  }
  // Every action is a push to the frame: a few a minute is someone tapping.
  const limited = await identityRateLimitResponse(auth.frame.id, "frames:panel-scenes", {
    limit: 60,
    windowMs: 15 * 60 * 1000,
  });
  if (limited) {
    return limited;
  }
  const body = await readJsonObject(request, 2 * 1024);
  const outcome = await runPanelSceneAction(db, auth.frame, body);
  return NextResponse.json(outcome.body, { status: outcome.status });
}

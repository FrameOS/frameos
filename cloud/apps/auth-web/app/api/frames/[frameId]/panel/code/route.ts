import { NextRequest, NextResponse } from "next/server";
import { jsonError, readBoundedJsonObject, requireDatabase } from "../../../../../../src/lib/device-flow";
import { authenticateFrameDevice } from "../../../../../../src/lib/frame-device-auth";
import { maxPanelCodeBodyBytes, runPanelCodeAction } from "../../../../../../src/lib/panel-code";
import { identityRateLimitResponse } from "../../../../../../src/lib/rate-limit";

export const runtime = "nodejs";

// The code editor on a frame (docs/code-editor.md "The plane"). The DEVICE
// calls this with its enrollment token, like /panel/scenes; the frame in the
// path must be the token's. Body (at most 1 MiB):
//   {"action": "ask", "prompt", "scene"?}  -> {"ok": true, "scene", "summary"}
//   {"action": "save", "scene", "show"?}   -> {"ok": true, "status": "queued", …}
// or {"ok": false, "error", "detail"?}. What each does, and what a frame may
// not do that its owner may, is panel-code.ts.
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
  const parsed = await readBoundedJsonObject(request, maxPanelCodeBodyBytes);
  if (parsed.response) {
    return parsed.response;
  }
  const body = parsed.body ?? {};
  // A save is a push, counted with the Scene store's changes (60 a quarter
  // hour); an ask is a paid model turn, twenty an hour.
  const limited =
    body.action === "ask"
      ? await identityRateLimitResponse(auth.frame.id, "frames:panel-code-ask", {
          limit: 20,
          windowMs: 60 * 60 * 1000,
        })
      : await identityRateLimitResponse(auth.frame.id, "frames:panel-scenes", {
          limit: 60,
          windowMs: 15 * 60 * 1000,
        });
  if (limited) {
    return limited;
  }
  const outcome = await runPanelCodeAction(db, auth.frame, body);
  return NextResponse.json(outcome.body, { status: outcome.status });
}

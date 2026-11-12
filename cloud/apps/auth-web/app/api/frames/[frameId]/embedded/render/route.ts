import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireDatabase } from "../../../../../../src/lib/device-flow";
import { authenticateFrameDevice } from "../../../../../../src/lib/frame-device-auth";
import {
  checkIdentityRateLimit,
  rateLimitResponse,
} from "../../../../../../src/lib/rate-limit";
import { reportError } from "../../../../../../src/lib/log";
import {
  parseServerRenderPanel,
  pullServerRender,
} from "../../../../../../src/lib/server-render";
import {
  accountLimits,
  countCloudRenderedFramesForAccount,
  frameIsCloudRendered,
} from "../../../../../../src/lib/usage";

export const runtime = "nodejs";

// The render pull of a frame the cloud renders for (docs/server-rendering.md):
// an ESP32-C3, or a board whose owner set `render_mode` to "remote". Called
// by the DEVICE with its enrollment access token:
//
//   GET /api/frames/{id}/embedded/render?scene=&width=&height=&format=&rotate=
//   If-None-Match: "<etag of the picture the panel shows>"
//   -> 200 FOSB (the packed panel bytes), ETag, Cache-Control: no-store
//   -> 304 when the panel already shows it
//   -> 400 invalid_panel, 403 not_server_rendered /
//      cloud_rendered_frame_quota_exceeded, 409 no_scenes,
//      429 render_rate_limited, 502 render_failed, 503 renderer_unavailable /
//      renderer_busy (Retry-After)
//
// Renders per day are what this costs, so a pull reuses the last picture
// while nothing it depends on changed and the plan's floor has not passed,
// takes the picture the hub drew before a sleeping frame's wake, and only
// then renders, under a per-frame budget.

// Renders (not pulls) one frame may start per window: a key pressed again
// and again switches scenes on the device, and each switch is a render.
const frameRenderRateLimit = { limit: 30, windowMs: 15 * 60 * 1000 };

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ frameId: string }> },
) {
  const limited = await rateLimitResponse(request, "frames:server-render", {
    limit: 240,
    windowMs: 15 * 60 * 1000,
  });
  if (limited) {
    return limited;
  }
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
  if (auth.frame.status !== "active") {
    return jsonError("frame_not_active", 409);
  }
  // The plane's own record decides, never the device's word: a board set to
  // remote on its console but not here renders that pass itself.
  if (!frameIsCloudRendered(auth.frame)) {
    return jsonError("not_server_rendered", 403);
  }
  const panel = parseServerRenderPanel(request.nextUrl.searchParams);
  if (!panel) {
    return jsonError("invalid_panel", 400);
  }
  // An account over its plan (a downgrade) keeps its frames, and the cloud
  // stops drawing for them: the device keeps the picture it shows.
  const limits = await accountLimits(db, auth.frame.accountId);
  if ((await countCloudRenderedFramesForAccount(db, auth.frame.accountId)) > limits.cloudRenderedFrames) {
    return jsonError("cloud_rendered_frame_quota_exceeded", 403, {
      max_cloud_rendered_frames: limits.cloudRenderedFrames,
    });
  }

  const scene = request.nextUrl.searchParams.get("scene");
  let pulled;
  try {
    pulled = await pullServerRender(db, {
      deviceScene: scene && scene.length > 0 ? scene : undefined,
      frame: auth.frame,
      ifNoneMatch: request.headers.get("if-none-match"),
      linkedClient: auth.linkedClient,
      mayRender: async () =>
        (await checkIdentityRateLimit(`frame:${auth.frame.id}`, "frames:server-render", frameRenderRateLimit)).allowed,
      panel,
    });
  } catch (error) {
    reportError("frames.server_render_failed", error, { frameId: auth.frame.id });
    return jsonError("render_failed", 502);
  }
  const headers = { "Cache-Control": "no-store" };
  if (pulled.status === 304) {
    return new NextResponse(null, { headers: { ...headers, ETag: `"${pulled.etag}"` }, status: 304 });
  }
  if (pulled.status === 200) {
    return new NextResponse(new Uint8Array(pulled.body), {
      headers: {
        ...headers,
        "Content-Length": String(pulled.body.length),
        "Content-Type": "application/octet-stream",
        ETag: `"${pulled.etag}"`,
        "X-FrameOS-Scene": encodeURIComponent(pulled.scene),
      },
      status: 200,
    });
  }
  const failure = jsonError(pulled.error, pulled.status, { message: pulled.message });
  failure.headers.set("Cache-Control", "no-store");
  if (pulled.retryAfterSeconds) {
    failure.headers.set("Retry-After", String(pulled.retryAfterSeconds));
  }
  return failure;
}

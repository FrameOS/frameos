import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireDatabase } from "../../../../../../src/lib/device-flow";
import { authenticateFrameDevice } from "../../../../../../src/lib/frame-device-auth";
import {
  checkIdentityRateLimit,
  rateLimitResponse,
} from "../../../../../../src/lib/rate-limit";
import { reportError } from "../../../../../../src/lib/log";
import {
  maxDeviceInputBytes,
  parseServerRenderPanel,
  pullServerRender,
  readDeviceInput,
} from "../../../../../../src/lib/server-render";
import type { RelayedDeviceInput } from "../../../../../../src/lib/scene-render";
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
//
//   POST, the same, when the frame has input for its scene: its key edges
//   and what its own producers (keys, touch, schedule, HTTP API) would have
//   handed its scene, as JSON (docs/server-rendering.md "Keys, touch and the
//   schedule"); delivered before the render, which never reuses a picture.
//   -> 400 invalid_input, 413 input_too_large
//
//   -> 400 invalid_panel, 403 not_server_rendered /
//      cloud_rendered_frame_quota_exceeded, 409 no_scenes,
//      429 render_rate_limited, 502 render_failed, 503 renderer_unavailable /
//      renderer_busy (Retry-After)
//
// Renders per day are what this costs, so a pull reuses the last picture
// while nothing it depends on changed and the plan's floor has not passed,
// takes the picture the hub drew before a sleeping frame's wake, and only
// then renders, under a per-frame budget.

// Renders (not pulls) one frame may start per window for its own timing:
// the plan's floor allows one per five minutes, so this is a lot.
const frameRenderRateLimit = { limit: 30, windowMs: 15 * 60 * 1000 };
// And for input: every key press, tap and scheduled switch is a render, and
// a person at the frame (the switcher, a scene's own buttons, the settings
// keyboard) taps a few times a minute, each tap one pull of a second or
// three. Its own bucket, so using the frame never starves its schedule, and
// big enough for a quarter hour of steady tapping: one every five seconds.
// The renderer's per-account queue (one in flight, two waiting) bounds the
// cost of a burst.
const frameInputRenderRateLimit = { limit: 180, windowMs: 15 * 60 * 1000 };
// Pulls per address, before the device is even known: input pulls come in
// bursts, and several frames can share an address.
const pullRateLimit = { limit: 480, windowMs: 15 * 60 * 1000 };

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ frameId: string }> },
) {
  return pull(request, params, undefined);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ frameId: string }> },
) {
  return pull(request, params, async () => {
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > maxDeviceInputBytes) {
      return jsonError("input_too_large", 413);
    }
    const raw = await request.arrayBuffer();
    if (raw.byteLength > maxDeviceInputBytes) {
      return jsonError("input_too_large", 413);
    }
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      return jsonError("invalid_input", 400);
    }
    return readDeviceInput(body) ?? jsonError("invalid_input", 400);
  });
}

async function pull(
  request: NextRequest,
  params: Promise<{ frameId: string }>,
  // The POST's body, read once the device is known: its input, or the answer
  // that refuses it.
  readInput: (() => Promise<RelayedDeviceInput | NextResponse>) | undefined,
) {
  const limited = await rateLimitResponse(request, "frames:server-render", pullRateLimit);
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

  let deviceInput: RelayedDeviceInput | undefined;
  if (readInput) {
    const input = await readInput();
    if (input instanceof NextResponse) {
      return input;
    }
    deviceInput = input;
  }

  const scene = request.nextUrl.searchParams.get("scene");
  let pulled;
  try {
    pulled = await pullServerRender(db, {
      deviceInput,
      deviceScene: scene && scene.length > 0 ? scene : undefined,
      frame: auth.frame,
      ifNoneMatch: request.headers.get("if-none-match"),
      linkedClient: auth.linkedClient,
      mayRender: async (reason) =>
        reason === "input"
          ? (
              await checkIdentityRateLimit(
                `frame:${auth.frame.id}`,
                "frames:server-render-input",
                frameInputRenderRateLimit,
              )
            ).allowed
          : (await checkIdentityRateLimit(`frame:${auth.frame.id}`, "frames:server-render", frameRenderRateLimit))
              .allowed,
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

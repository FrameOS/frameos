// The view link's three answers (docs/cloud-frames.md "Virtual frames"): the
// page a kiosk browser shows, the picture, and the small status the page
// asks for between pictures. No login: the token in the address is the
// credential, as on a photo album's share link. Whoever has it sees this
// frame's picture and nothing else — not its scenes, not its settings, not
// the account.

import { NextRequest, NextResponse } from "next/server";
import { readBlob } from "./blobs";
import { jsonError, requireDatabase } from "./device-flow";
import { cachedAssetFile } from "./frame-asset-cache";
import { frameImageAssetPath } from "./frames";
import { rateLimitResponse } from "./rate-limit";
import {
  markVirtualFrameViewed,
  virtualFrameForViewToken,
  virtualFrameIntervalSeconds,
} from "./virtual-frame-view";
import { virtualFrameSize, virtualImagePath, virtualViewPath } from "./virtual-frames";

// Per address. A page asks for its status every twenty seconds and for the
// picture when it changed, so one screen spends about fifty an interval;
// this leaves room for a wall of them behind one router.
const viewRateLimit = { limit: 1200, windowMs: 15 * 60 * 1000 };
// How often the page asks whether there is a new picture.
export const viewPollSeconds = 20;

// The address carries the token: nothing may keep it. `no-referrer` so a
// link inside the page (there is none today) could never leak it either.
const privateHeaders = {
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-robots-tag": "noindex, nofollow",
};

async function viewContext(request: NextRequest, token: string) {
  const refused = (response: NextResponse) => ({ ok: false as const, response });
  const limited = await rateLimitResponse(request, "frames:virtual-view", viewRateLimit);
  if (limited) {
    return refused(limited);
  }
  const { db, response } = requireDatabase();
  if (!db) {
    return refused(response);
  }
  const row = await virtualFrameForViewToken(db, token);
  if (!row) {
    return refused(jsonError("not_found", 404));
  }
  // Every read is "someone is looking": it is what keeps the frame drawing.
  await markVirtualFrameViewed(db, row.frame.id);
  return { db, ok: true as const, ...row };
}

function statusBody(
  frame: Parameters<typeof virtualFrameIntervalSeconds>[0] & { hardware: unknown },
  virtual: Parameters<typeof virtualFrameIntervalSeconds>[1] & {
    imageVersion: string | null;
    renderedAt: Date | null;
  },
) {
  const size = virtualFrameSize(frame.hardware);
  return {
    height: size.height,
    interval_seconds: virtualFrameIntervalSeconds(frame, virtual),
    rendered_at: virtual.renderedAt,
    // Changes when the picture does; null until the frame has drawn one.
    version: virtual.imageVersion,
    width: size.width,
  };
}

export async function virtualStatusResponse(request: NextRequest, token: string): Promise<NextResponse> {
  const context = await viewContext(request, token);
  if (!context.ok) {
    return context.response;
  }
  return NextResponse.json(statusBody(context.frame, context.virtual), {
    headers: { ...privateHeaders, "cache-control": "no-store" },
  });
}

export async function virtualImageResponse(request: NextRequest, token: string): Promise<NextResponse> {
  const context = await viewContext(request, token);
  if (!context.ok) {
    return context.response;
  }
  const { db, frame, virtual } = context;
  const etag = virtual.imageVersion ? `"${virtual.imageVersion}"` : undefined;
  // `no-cache`: a browser may keep the bytes, and asks each time whether
  // they are still the picture. `private`: no shared cache may.
  const cacheControl = "private, no-cache";
  if (etag && request.headers.get("if-none-match") === etag) {
    return new NextResponse(null, {
      headers: { ...privateHeaders, "cache-control": cacheControl, etag },
      status: 304,
    });
  }
  const row = await cachedAssetFile(db, frame.id, frameImageAssetPath, false);
  const content = await readBlob(row);
  if (!row || !content) {
    // Nothing drawn yet (a new frame, or one with no scene). The read above
    // has asked for a render; the page says so, a bare <img> gets a 404.
    return jsonError("no_image", 404);
  }
  return new NextResponse(new Uint8Array(content), {
    headers: {
      ...privateHeaders,
      "cache-control": cacheControl,
      "content-length": String(content.length),
      // Always the hub's own PNG; never a type a device chose.
      "content-type": "image/png",
      ...(etag ? { etag } : {}),
    },
  });
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// A black page with the picture, for a kiosk browser, an old tablet, a TV.
// It asks for the status every viewPollSeconds and loads a new picture
// behind the one showing, so a change never flashes. The token is only in
// addresses it arrived with; the frame's name is the one thing drawn from
// the row, as text.
export function virtualViewPage(input: {
  height: number;
  name: string;
  token: string;
  version: string | null;
  width: number;
}): string {
  const image = virtualImagePath(input.token);
  const status = `${virtualViewPath(input.token)}/status`;
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(input.name)}</title>
<style>
  html, body { margin: 0; height: 100%; background: #000; }
  body { display: flex; align-items: center; justify-content: center; }
  img { max-width: 100vw; max-height: 100vh; object-fit: contain; }
  img[hidden] { display: none; }
  p { color: #9ca3af; font: 16px/1.5 system-ui, sans-serif; text-align: center; padding: 0 24px; }
</style></head>
<body>
<img id="frame" width="${input.width}" height="${input.height}" alt=""${input.version ? ` src="${image}?v=${encodeURIComponent(input.version)}"` : " hidden"}>
<p id="empty"${input.version ? " hidden" : ""}>This frame has not drawn anything yet. Give it a scene, and it appears here.</p>
<script>
  var img = document.getElementById('frame');
  var empty = document.getElementById('empty');
  var shown = ${JSON.stringify(input.version)};
  function check() {
    fetch(${JSON.stringify(status)}, { cache: 'no-store' })
      .then(function (response) {
        // The link was replaced or the frame is gone: stop asking, keep the picture.
        if (response.status === 404) { clearInterval(timer); return null; }
        return response.ok ? response.json() : null;
      })
      .then(function (status) {
        if (!status || !status.version || status.version === shown) { return; }
        var next = new Image();
        next.onload = function () {
          shown = status.version;
          img.width = status.width; img.height = status.height;
          img.src = next.src; img.hidden = false; empty.hidden = true;
        };
        next.src = ${JSON.stringify(image)} + '?v=' + encodeURIComponent(status.version);
      })
      .catch(function () {});
  }
  var timer = setInterval(check, ${viewPollSeconds * 1000});
  document.addEventListener('visibilitychange', function () { if (!document.hidden) { check(); } });
</script>
</body></html>`;
}

export async function virtualPageResponse(request: NextRequest, token: string): Promise<NextResponse> {
  const context = await viewContext(request, token);
  if (!context.ok) {
    // A person opened this, not a client: say it in words.
    if (context.response.status === 404) {
      return new NextResponse("This link does not show a frame any more.", {
        headers: { ...privateHeaders, "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" },
        status: 404,
      });
    }
    return context.response;
  }
  const size = virtualFrameSize(context.frame.hardware);
  return new NextResponse(
    virtualViewPage({
      height: size.height,
      name: context.frame.name,
      token,
      version: context.virtual.imageVersion,
      width: size.width,
    }),
    {
      headers: {
        ...privateHeaders,
        "cache-control": "no-store",
        "content-type": "text/html; charset=utf-8",
      },
    },
  );
}

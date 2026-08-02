import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

// SPA fallback for the cloud frames UI: every /frames/** path serves the
// @frameos/cloud-frontend shell (copied into public/frames-app by
// scripts/copy-frames-app-assets.mjs). The bundle's static assets are
// root-absolute /frames-app/* references that Next serves from public/
// directly, so this route only ever answers with the HTML shell. The SPA
// itself redirects to /login on 401 — the shell is served unauthenticated,
// like every other static asset. See cloud-frontend/README.md.
export async function GET() {
  let html: string;
  try {
    html = await readFile(
      join(process.cwd(), "public", "frames-app", "index.html"),
      "utf8",
    );
  } catch {
    return new NextResponse(
      "The frames UI is not built. Run `turbo run build --filter=@frameos/cloud-frontend` " +
        "and restart (scripts/copy-frames-app-assets.mjs copies it into public/frames-app).",
      { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }

  // In production nginx routes /api/frames/ws and /api/frames/**/updates to
  // the frame hub on the same origin, so no override is needed. In dev the
  // hub is a separate port — FRAME_HUB_PUBLIC_URL (e.g. http://localhost:3100)
  // tells the SPA where its fleet websocket lives.
  // The anchor is a named token, not a formatted line, so reindenting the
  // shell can't silently turn this into a no-op — and if it goes missing
  // entirely we say so instead of serving a SPA whose websocket points nowhere.
  const wsOriginAnchor = "//__FRAMEOS_CLOUD_WS_ORIGIN__";
  const hubOrigin = process.env.FRAME_HUB_PUBLIC_URL?.replace(/\/$/, "");
  if (hubOrigin) {
    if (!html.includes(wsOriginAnchor)) {
      return new NextResponse(
        `FRAME_HUB_PUBLIC_URL is set but the frames app shell has no ${wsOriginAnchor} anchor, ` +
          "so the fleet websocket origin cannot be injected. Rebuild cloud-frontend.",
        { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } },
      );
    }
    html = html.replace(
      wsOriginAnchor,
      `cloud_ws_origin: ${JSON.stringify(hubOrigin)},`,
    );
  }

  return new NextResponse(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      // The shell references hashless /frames-app/static/main.js|css, so it
      // must never be cached across deploys.
      "cache-control": "no-store",
    },
  });
}

import { NextRequest, NextResponse } from "next/server";
import { getAccountPath, getAccountUrl } from "../../../src/lib/env";
import { GET as serveFramesAppShell } from "../../frames/[[...path]]/route";

export const runtime = "nodejs";

// The account pages — backends, service keys, SSH keys, usage, backups,
// activity, security, developer — are scenes of the frames workspace SPA
// since 2026.10 (frontend/src/scenes/settings/account), kept at the
// /account/<page> addresses the Next.js pages had. So /account/** serves the
// same shell as /frames/** (the SPA's router knows both; its static assets
// are root-absolute /frames-app/* either way), with one addition: a section
// that was renamed or merged on the way (/account/installs, /account/settings,
// /account/ai) and the bare /account redirect to their page first, through
// getAccountPath's table (src/lib/env.ts). In production the surface router
// (src/lib/surfaces.ts) redirects most of those before this runs; this is
// what the single-origin dev setup — and any path the router leaves alone —
// relies on.
export async function GET(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const target = getAccountPath(pathname);
  if (target !== pathname) {
    // 307 + no-store, like the surface router: which path serves which page
    // is deployment config, and a permanent redirect freezes into caches.
    const destination = new URL(getAccountUrl(target));
    if (!destination.search) {
      destination.search = search;
    }
    return NextResponse.redirect(destination, {
      status: 307,
      headers: { "cache-control": "no-store" },
    });
  }
  return serveFramesAppShell(request);
}

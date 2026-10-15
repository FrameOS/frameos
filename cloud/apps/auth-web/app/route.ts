import { NextRequest, NextResponse } from "next/server";
import { getHomeUrl, getStorePath } from "../src/lib/env";
import { GET as serveFramesAppShell } from "./frames/[[...path]]/route";

export const runtime = "nodejs";

// On the scenes host the root is the store front: the frames workspace SPA's
// shell, which renders the public store for a visitor without a session and
// the scenes library for one with (app/store/route.ts is the same page where
// the store shares the cloud origin). When the store shares the cloud origin
// (local development — production's cloud host never reaches this route, the
// surface router sends its root to /home first) the root is the workspace's
// home page instead, and the store front lives at /store.
export async function GET(request: NextRequest) {
  if (getStorePath() !== "/") {
    return NextResponse.redirect(getHomeUrl(), {
      status: 307,
      headers: { "cache-control": "no-store" },
    });
  }
  return serveFramesAppShell(request);
}

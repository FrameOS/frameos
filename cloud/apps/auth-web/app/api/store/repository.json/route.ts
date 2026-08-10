import { NextRequest, NextResponse } from "next/server";
import { requireDatabase } from "../../../../src/lib/device-flow";
import { rateLimitResponse } from "../../../../src/lib/rate-limit";
import { buildStoreRepository } from "../../../../src/lib/store-repository";

export const runtime = "nodejs";

// The public store index in the frameos repository JSON format, so any
// FrameOS install (old or new) can add
//   {provider}/api/store/repository.json
// as a plain scenes repository. frameos resolves "./..." URLs against this
// file's URL, which lands on /api/store/scenes/{id}/....
//
// This URL lists EVERY public scene, whatever FrameOS version it declares.
// Installs pointing here were configured before versioned indexes existed and
// we cannot know which FrameOS they run, so filtering them down would silently
// remove scenes people already see. Every template carries its own
// `frameosVersion`, so the install can warn locally. Installs that want a
// filtered index use /api/store/{frameosVersion}/repository.json.
export async function GET(request: NextRequest) {
  const limited = await rateLimitResponse(request, "store:index", {
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

  return NextResponse.json(await buildStoreRepository(db), {
    headers: { "cache-control": "public, max-age=300" },
  });
}

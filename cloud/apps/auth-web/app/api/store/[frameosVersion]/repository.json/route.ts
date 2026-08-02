import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireDatabase } from "../../../../../src/lib/device-flow";
import { rateLimitResponse } from "../../../../../src/lib/rate-limit";
import { buildStoreRepository } from "../../../../../src/lib/store-repository";
import { normalizeRequestedFrameosVersion } from "../../../../../src/lib/store-versions";

export const runtime = "nodejs";

// The store index filtered to one FrameOS version:
//   {provider}/api/store/2026.8.0/repository.json
// Only scenes whose declared minimum FrameOS version is <= 2026.8.0 are
// listed, so an install pointed at its own version never sees a template it
// cannot run. Scenes that declare nothing are listed: their requirement is
// unknown, not "too new".
//
// The version is a path segment (not a query parameter) so the whole index is
// a plain cacheable URL that a user can paste into the repository field of any
// FrameOS install, old or new.
//
// Note on routing: Next.js prefers static segments over dynamic ones, so the
// sibling /api/store/repository.json and /api/store/account/repository.json
// routes keep winning over this [frameosVersion] segment — and "account" is
// not a valid version anyway.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ frameosVersion: string }> },
) {
  const limited = await rateLimitResponse(request, "store:index", {
    limit: 240,
    windowMs: 15 * 60 * 1000,
  });
  if (limited) {
    return limited;
  }

  const { frameosVersion: requested } = await params;
  const frameosVersion = normalizeRequestedFrameosVersion(requested);
  if (!frameosVersion) {
    return jsonError("invalid_frameos_version", 404);
  }

  const { db, response } = requireDatabase();
  if (!db) {
    return response;
  }

  return NextResponse.json(await buildStoreRepository(db, { frameosVersion }), {
    headers: { "cache-control": "public, max-age=300" },
  });
}

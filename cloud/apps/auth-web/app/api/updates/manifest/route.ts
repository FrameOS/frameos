import { NextRequest, NextResponse } from "next/server";
import { jsonError } from "../../../../src/lib/device-flow";
import { rateLimitResponse } from "../../../../src/lib/rate-limit";
import { fetchUpdateManifest } from "../../../../src/lib/update-manifest";

export const runtime = "nodejs";

// The update manifest's mirror (docs/auto-updates.md "Where it lives, and
// who serves it"): the copy of docs/update-manifest.json the cloud last read
// from GitHub. Public: a self-hosted backend and a standalone Pi ask it when
// GitHub does not answer. No auth, no cookies, nothing about the caller kept.
//
//   GET /api/updates/manifest -> the manifest JSON, or 502 manifest_unavailable

const updatesBudget = { limit: 120, windowMs: 15 * 60 * 1000 };

export async function GET(request: NextRequest) {
  const limited = await rateLimitResponse(request, "updates:manifest", updatesBudget);
  if (limited) {
    return limited;
  }
  const manifest = await fetchUpdateManifest();
  if (!manifest) {
    return jsonError("manifest_unavailable", 502);
  }
  return NextResponse.json(manifest, { headers: { "cache-control": "public, max-age=300" } });
}

import { NextRequest, NextResponse } from "next/server";
import { jsonError } from "../../../../src/lib/device-flow";
import { rateLimitResponse } from "../../../../src/lib/rate-limit";
import { decideUpdate } from "../../../../src/lib/update-decision";
import { fetchUpdateManifest } from "../../../../src/lib/update-manifest";

export const runtime = "nodejs";

// The update decision for anyone who asks (docs/auto-updates.md "The
// decision service"): the rule of src/lib/update-decision.ts over the
// manifest the cloud last read from GitHub. Public, nothing kept.
//
//   GET /api/updates/next?platform=linux&target=debian-bookworm-arm64
//       &version=2026.11.13&key=<cohort key>&channel=stable&manual=0
//   -> { version, reason, latest, held }
//
// `platform` is linux | esp32 | pico; `key` is the frame's cohort key (no
// key: the frame waits for a release to reach 100%).

const nextBudget = { limit: 120, windowMs: 15 * 60 * 1000 };
const platforms = new Set(["linux", "esp32", "pico"]);
const maxParamLength = 200;

function param(request: NextRequest, name: string): string {
  return (request.nextUrl.searchParams.get(name) ?? "").trim().slice(0, maxParamLength);
}

export async function GET(request: NextRequest) {
  const limited = await rateLimitResponse(request, "updates:next", nextBudget);
  if (limited) {
    return limited;
  }
  const platform = param(request, "platform");
  if (!platforms.has(platform)) {
    return jsonError("invalid_platform", 400);
  }
  const manifest = await fetchUpdateManifest();
  if (!manifest) {
    return jsonError("manifest_unavailable", 502);
  }
  const manual = param(request, "manual");
  const decision = decideUpdate(manifest, {
    channel: param(request, "channel") || "stable",
    current: param(request, "version"),
    frameKey: param(request, "key"),
    manual: manual === "1" || manual === "true",
    now: new Date().toISOString(),
    platform,
    target: param(request, "target"),
  });
  return NextResponse.json(decision, { headers: { "cache-control": "no-store" } });
}

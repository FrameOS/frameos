import { NextRequest, NextResponse } from "next/server";
import { jsonError, readBoundedJsonObject } from "../../../../src/lib/device-flow";
import { parseFlasherEvent } from "../../../../src/lib/flasher-events";
import { capturePostHogEvent } from "../../../../src/lib/posthog-capture";
import { rateLimitResponse } from "../../../../src/lib/rate-limit";

export const runtime = "nodejs";

// One event of flash.frameos.net's (src/lib/flasher-events.ts says what it
// may hold). Served on the flasher's host (surfaces.ts flasherServesApi),
// where the proxy has already taken any cookie off: this route reads no
// session and writes nothing of its own. PostHog gets the visit id the page
// made up, no person profile, and no address to place it by.
const maxEventBytes = 2 * 1024;

export async function POST(request: NextRequest) {
  const limited = await rateLimitResponse(request, "flasher:events", {
    limit: 300,
    windowMs: 15 * 60 * 1000,
  });
  if (limited) {
    return limited;
  }
  const read = await readBoundedJsonObject(request, maxEventBytes);
  if (read.response) {
    return read.response;
  }
  const parsed = parseFlasherEvent(read.body);
  if (!parsed) {
    return jsonError("invalid_event", 400);
  }
  await capturePostHogEvent(parsed.event, parsed.visit, {
    ...parsed.properties,
    $geoip_disable: true,
    $process_person_profile: false,
    surface: "flasher",
  });
  return new NextResponse(null, { status: 204 });
}

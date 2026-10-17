import { NextRequest } from "next/server";
import { handleLanAccessChallenge } from "../../../../../../src/lib/frame-lan-access-route";

export const runtime = "nodejs";

// Asks the frame to draw a local network access code on its panel (the queued
// `lan_access_challenge` verb, docs/lan-access.md). The owner then types the code into POST /api/frames/{id}/lan_access.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ frameId: string }> },
) {
  return handleLanAccessChallenge(request, params);
}

import { NextRequest } from "next/server";
import { handleLanAccessSet } from "../../../../../src/lib/frame-lan-access-route";

export const runtime = "nodejs";

// The frame's local network access switch, body {enabled: bool, code?: string}
// (docs/lan-access.md). Turning it on needs the code a /lan_access/challenge put on the panel;
// turning it off needs none. Mapped onto the queued `lan_access_set` verb.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ frameId: string }> },
) {
  return handleLanAccessSet(request, params);
}

import { NextRequest, NextResponse } from "next/server";
import { sceneGuide, sceneGuideSectionIds } from "../../../../src/lib/ai/scene-reference";
import { jsonError } from "../../../../src/lib/device-flow";
import { rateLimitResponse } from "../../../../src/lib/rate-limit";

export const runtime = "nodejs";

// How to write a scene (docs/scene-guide.md), for the MCP server's
// scene_guide: the whole guide, or ?section=<id> for one part. The same text
// the scene AI reads; public, like the docs it comes from.
export async function GET(request: NextRequest) {
  const limited = await rateLimitResponse(request, "scenes:guide", {
    limit: 240,
    windowMs: 15 * 60 * 1000,
  });
  if (limited) {
    return limited;
  }
  const section = request.nextUrl.searchParams.get("section");
  const reply = sceneGuide(section);
  if (!reply) {
    return jsonError("unknown_section", 404, { sections: sceneGuideSectionIds() });
  }
  return NextResponse.json(reply);
}

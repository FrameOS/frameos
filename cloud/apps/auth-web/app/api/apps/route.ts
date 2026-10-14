import { NextRequest, NextResponse } from "next/server";
import { appRows } from "../../../src/lib/ai/scene-reference";
import { rateLimitResponse } from "../../../src/lib/rate-limit";

export const runtime = "nodejs";

// The app catalog a scene's nodes come from (the scene AI's own), for the MCP
// server's apps_list: ?search= narrows it, ?category= picks data, logic or
// render. Public: it is the repo's catalog.
export async function GET(request: NextRequest) {
  const limited = await rateLimitResponse(request, "apps:list", {
    limit: 240,
    windowMs: 15 * 60 * 1000,
  });
  if (limited) {
    return limited;
  }
  const params = request.nextUrl.searchParams;
  return NextResponse.json(appRows(params.get("search"), params.get("category")));
}

import { NextRequest, NextResponse } from "next/server";
import { appSourceFiles } from "../../../../src/lib/ai/scene-reference";
import { jsonError } from "../../../../src/lib/device-flow";
import { rateLimitResponse } from "../../../../src/lib/rate-limit";

export const runtime = "nodejs";

// One catalog app's files, for the MCP server's app_source_get: a repo JS
// app's sources (what a scene copies into its `apps` map), or a built-in
// app's config.json.
export async function GET(request: NextRequest) {
  const limited = await rateLimitResponse(request, "apps:source", {
    limit: 240,
    windowMs: 15 * 60 * 1000,
  });
  if (limited) {
    return limited;
  }
  const keyword = request.nextUrl.searchParams.get("keyword") ?? "";
  const files = keyword ? appSourceFiles(keyword) : undefined;
  if (!files) {
    return jsonError("unknown_app", 404, { keyword });
  }
  return NextResponse.json(files);
}

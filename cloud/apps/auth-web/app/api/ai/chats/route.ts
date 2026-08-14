import { NextRequest, NextResponse } from "next/server";
import { listChats } from "../../../../src/lib/ai/chat-store";
import { jsonError, requireDatabase } from "../../../../src/lib/device-flow";
import { isFrameId } from "../../../../src/lib/frames";
import { rateLimitResponse } from "../../../../src/lib/rate-limit";
import { readSession } from "../../../../src/lib/session";

export const runtime = "nodejs";

// Paged chat list for the SPA's AI drawer ({chats, hasMore, nextOffset} — the
// shape chatLogic's loadChats expects from the self-hosted backend).
export async function GET(request: NextRequest) {
  const limited = await rateLimitResponse(request, "ai:chats", {
    limit: 300,
    windowMs: 15 * 60 * 1000,
  });
  if (limited) {
    return limited;
  }
  const session = await readSession();
  if (!session?.accountId) {
    return jsonError("login_required", 401);
  }
  const { db, response } = requireDatabase();
  if (!db) {
    return response;
  }

  const params = request.nextUrl.searchParams;
  const frameIdRaw = params.get("frameId");
  const frameId = isFrameId(frameIdRaw) ? frameIdRaw : null;
  const limitRaw = Number.parseInt(params.get("limit") ?? "", 10);
  const offsetRaw = Number.parseInt(params.get("offset") ?? "", 10);
  const limit =
    Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 100) : 20;
  const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? offsetRaw : 0;

  const result = await listChats(db, session.accountId, {
    frameId,
    limit,
    offset,
  });
  return NextResponse.json(result);
}

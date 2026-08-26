import { NextRequest, NextResponse } from "next/server";
import { getTurn, stopTurn, turnStream } from "../../../../../../src/lib/ai/turn-runner";
import { csrfResponse } from "../../../../../../src/lib/csrf";
import { jsonError } from "../../../../../../src/lib/device-flow";
import { logInfo, logWarn } from "../../../../../../src/lib/log";
import { rateLimitResponse } from "../../../../../../src/lib/rate-limit";
import { readSession } from "../../../../../../src/lib/session";

export const runtime = "nodejs";
export const maxDuration = 600;

type RouteContext = { params: Promise<{ turnId: string }> };

// Resume a turn's event stream from event index `after` (the count of events
// the client had already seen). Same NDJSON as POST /api/ai/chat; closes when
// the turn is over. 404 once the turn is gone (finished more than
// FINISHED_TURN_TTL_MS ago, or the process restarted).
export async function GET(request: NextRequest, context: RouteContext) {
  const limited = await rateLimitResponse(request, "ai:chat:resume", {
    limit: 120,
    windowMs: 15 * 60 * 1000,
  });
  if (limited) {
    return limited;
  }
  const session = await readSession();
  if (!session?.accountId) {
    return jsonError("login_required", 401);
  }
  const { turnId } = await context.params;
  const turn = getTurn(turnId);
  if (!turn || turn.accountId !== session.accountId) {
    return jsonError("turn_not_found", 404, {
      detail: "That turn is no longer available to resume.",
    });
  }
  const afterRaw = Number(request.nextUrl.searchParams.get("after") ?? "0");
  const after = Number.isFinite(afterRaw) && afterRaw > 0 ? Math.floor(afterRaw) : 0;
  turn.resumes += 1;
  logInfo("ai.chat.turn_resumed", {
    accountId: session.accountId,
    after,
    buffered: turn.events.length,
    chatId: turn.chatId,
    elapsedMs: Date.now() - turn.startedAt,
    finished: turn.finishedAt !== null,
    turnId,
  });
  const stream = turnStream(turn, after, {
    onDisconnect: (delivered) => {
      logWarn("ai.chat.client_disconnected", {
        accountId: session.accountId,
        afterEvents: delivered,
        chatId: turn.chatId,
        elapsedMs: Date.now() - turn.startedAt,
        resumed: true,
        turnId,
      });
    },
  });
  return new Response(stream, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "X-Accel-Buffering": "no",
    },
  });
}

// Stop a running turn (the panel's Stop button). Before turns ran detached,
// closing the request was the stop; now it must be explicit.
export async function DELETE(request: NextRequest, context: RouteContext) {
  const csrf = csrfResponse(request);
  if (csrf) {
    return csrf;
  }
  const limited = await rateLimitResponse(request, "ai:chat:resume", {
    limit: 120,
    windowMs: 15 * 60 * 1000,
  });
  if (limited) {
    return limited;
  }
  const session = await readSession();
  if (!session?.accountId) {
    return jsonError("login_required", 401);
  }
  const { turnId } = await context.params;
  const turn = getTurn(turnId);
  if (!turn || turn.accountId !== session.accountId) {
    return jsonError("turn_not_found", 404);
  }
  stopTurn(turn);
  return NextResponse.json({ stopped: true });
}

import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { accounts, auditEvents } from "@frameos-cloud/db";
import { NextRequest, NextResponse } from "next/server";
import {
  auditEventDetail,
  auditEventLabel,
  summarizeAuditActor,
} from "../../../../../src/lib/audit-labels";
import { jsonError, requireDatabase } from "../../../../../src/lib/device-flow";
import { frameForAccount } from "../../../../../src/lib/frames";
import { rateLimitResponse } from "../../../../../src/lib/rate-limit";
import { readSession } from "../../../../../src/lib/session";

export const runtime = "nodejs";

const defaultLimit = 50;
const maxLimit = 200;

// The frame's slice of the account audit trail: every audit_events row whose
// target names this frame (target->>'frameId', indexed by migration 0035),
// scoped to the session's account. Newest first; `?before=<iso>&before_id=`
// is the keyset cursor for "load older" (created_at ties broken by id), and
// `?limit=` caps the page at 200.
//
// Rows are rendered server-side with the same label/detail helpers the
// account activity page uses, so the shared SPA's Activity panel needs no
// copy of the event vocabulary. Actors are reduced to account / device /
// system (+ IP, + the account's email when it is the owner's own action).
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ frameId: string }> },
) {
  const limited = await rateLimitResponse(request, "frames:activity", {
    limit: 600,
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

  const { frameId } = await params;
  const frame = await frameForAccount(db, session.accountId, frameId);
  if (!frame) {
    return jsonError("invalid_frame", 404);
  }

  const query = request.nextUrl.searchParams;
  const limitRaw = Number.parseInt(query.get("limit") ?? "", 10);
  const limit =
    Number.isFinite(limitRaw) && limitRaw > 0
      ? Math.min(limitRaw, maxLimit)
      : defaultLimit;
  const beforeRaw = query.get("before");
  const before = beforeRaw ? new Date(beforeRaw) : undefined;
  if (before && Number.isNaN(before.getTime())) {
    return jsonError("invalid_cursor", 400);
  }
  const beforeId = query.get("before_id") ?? undefined;
  if (
    beforeId !== undefined &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      beforeId,
    )
  ) {
    return jsonError("invalid_cursor", 400);
  }

  const frameTarget = sql`${auditEvents.target}->>'frameId'`;
  // Keyset cursor on (created_at desc, id desc). With before_id the
  // comparison is against the cursor row's OWN stored timestamp (a
  // subquery), not the ISO string the client echoes back: created_at holds
  // microseconds and an ISO date only milliseconds, so comparing against the
  // echoed value would skip rows written in the same millisecond as the
  // cursor row. A bare `before` is a coarse "older than this instant".
  const cursor = beforeId
    ? sql`(${auditEvents.createdAt}, ${auditEvents.id}) < (select ${auditEvents.createdAt}, ${auditEvents.id} from ${auditEvents} where ${auditEvents.id} = ${beforeId})`
    : before
      ? lt(auditEvents.createdAt, before)
      : undefined;

  const rows = await db
    .select({
      actor: auditEvents.actor,
      createdAt: auditEvents.createdAt,
      eventType: auditEvents.eventType,
      id: auditEvents.id,
      metadata: auditEvents.metadata,
    })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.accountId, session.accountId),
        eq(frameTarget, frame.id),
        ...(cursor ? [cursor] : []),
      ),
    )
    .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
    .limit(limit + 1);
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  const summaries = page.map((row) => summarizeAuditActor(row.actor));
  const actorAccountIds = [
    ...new Set(
      summaries
        .map((summary) => summary.accountId)
        .filter((id): id is string => typeof id === "string"),
    ),
  ];
  const emails = new Map<string, string>();
  if (actorAccountIds.length > 0) {
    const actorRows = await db
      .select({ email: accounts.primaryEmail, id: accounts.id })
      .from(accounts)
      .where(inArray(accounts.id, actorAccountIds));
    for (const row of actorRows) {
      if (row.email) {
        emails.set(row.id, row.email);
      }
    }
  }

  const last = page[page.length - 1];
  return NextResponse.json(
    {
      events: page.map((row, index) => {
        const summary = summaries[index]!;
        const email = summary.accountId
          ? emails.get(summary.accountId)
          : undefined;
        return {
          actor: {
            kind: summary.kind,
            ...(summary.ip ? { ip: summary.ip } : {}),
            ...(email ? { email } : {}),
          },
          created_at: row.createdAt.toISOString(),
          detail: auditEventDetail(row.metadata) ?? null,
          event_type: row.eventType,
          id: row.id,
          label: auditEventLabel(row.eventType),
          metadata: row.metadata ?? null,
        };
      }),
      has_more: hasMore,
      next_cursor:
        hasMore && last
          ? { before: last.createdAt.toISOString(), before_id: last.id }
          : null,
    },
    { headers: { "cache-control": "no-store" } },
  );
}

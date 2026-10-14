import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { auditEvents, frames, storeScenes } from "@frameos-cloud/db";
import { NextRequest, NextResponse } from "next/server";
import {
  activityConditions,
  parseActivityFilters,
} from "../../../../src/lib/account-activity";
import {
  auditEventDetail,
  auditEventLabel,
  auditEventTarget,
  summarizeAuditActor,
} from "../../../../src/lib/audit-labels";
import { jsonError, requireDatabase } from "../../../../src/lib/device-flow";
import { rateLimitResponse } from "../../../../src/lib/rate-limit";
import { readSession } from "../../../../src/lib/session";

export const runtime = "nodejs";

const defaultLimit = 50;
const maxLimit = 200;

// The account's activity feed (app/account/activity): audit_events for the
// session's account, newest first, filtered by `q`, `group`, `from` and `to`
// (src/lib/account-activity.ts) and paged with the same keyset cursor the
// per-frame feed uses: `?before=<iso>&before_id=<uuid>`. Each row carries the
// name of the frame or scene it is about, resolved within the account.
export async function GET(request: NextRequest) {
  const limited = await rateLimitResponse(request, "account:activity", {
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
  const accountId = session.accountId;

  const query = request.nextUrl.searchParams;
  const parsed = parseActivityFilters(query);
  if ("error" in parsed) {
    return jsonError("invalid_request", 400, { detail: parsed.error });
  }
  const limitRaw = Number.parseInt(query.get("limit") ?? "", 10);
  const limit =
    Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, maxLimit) : defaultLimit;
  const beforeRaw = query.get("before");
  const before = beforeRaw ? new Date(beforeRaw) : undefined;
  if (before && Number.isNaN(before.getTime())) {
    return jsonError("invalid_cursor", 400);
  }
  const beforeId = query.get("before_id") ?? undefined;
  if (
    beforeId !== undefined &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(beforeId)
  ) {
    return jsonError("invalid_cursor", 400);
  }
  // With before_id the comparison is against the cursor row's own stored
  // timestamp: created_at holds microseconds and an ISO string only
  // milliseconds, so comparing against the echoed value would skip rows
  // written in the same millisecond as the cursor row.
  const cursor = beforeId
    ? sql`(${auditEvents.createdAt}, ${auditEvents.id}) < (select ${auditEvents.createdAt}, ${auditEvents.id} from ${auditEvents} where ${auditEvents.id} = ${beforeId})`
    : before
      ? lt(auditEvents.createdAt, before)
      : undefined;

  const conditions = await activityConditions(db, accountId, parsed.filters);
  const rows = await db
    .select({
      actor: auditEvents.actor,
      createdAt: auditEvents.createdAt,
      eventType: auditEvents.eventType,
      id: auditEvents.id,
      metadata: auditEvents.metadata,
      target: auditEvents.target,
    })
    .from(auditEvents)
    .where(and(...conditions, ...(cursor ? [cursor] : [])))
    .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
    .limit(limit + 1);
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  // The frame / scene each row is about, as a name. Scoped to the account so
  // a row can never label a foreign id; a frame deleted since keeps its row
  // and shows no name.
  const targets = page.map((row) => auditEventTarget(row.target));
  const frameIds = [...new Set(targets.flatMap((t) => (t.frameId ? [t.frameId] : [])))];
  const sceneIds = [...new Set(targets.flatMap((t) => (t.sceneId ? [t.sceneId] : [])))];
  const [frameRows, sceneRows] = await Promise.all([
    frameIds.length > 0
      ? db
          .select({ id: frames.id, name: frames.name })
          .from(frames)
          .where(and(eq(frames.accountId, accountId), inArray(frames.id, frameIds)))
      : [],
    sceneIds.length > 0
      ? db
          .select({ id: storeScenes.id, name: storeScenes.name })
          .from(storeScenes)
          .where(and(eq(storeScenes.accountId, accountId), inArray(storeScenes.id, sceneIds)))
      : [],
  ]);
  const frameNames = new Map(frameRows.map((f) => [f.id, f.name]));
  const sceneNames = new Map(sceneRows.map((s) => [s.id, s.name]));

  const last = page[page.length - 1];
  return NextResponse.json(
    {
      events: page.map((row, index) => {
        const target = targets[index] ?? {};
        const actor = summarizeAuditActor(row.actor);
        return {
          created_at: row.createdAt.toISOString(),
          detail: auditEventDetail(row.metadata) ?? null,
          event_type: row.eventType,
          frame_id: target.frameId ?? null,
          frame_name: target.frameId ? (frameNames.get(target.frameId) ?? null) : null,
          id: row.id,
          ip: actor.ip ?? null,
          label: auditEventLabel(row.eventType),
          scene_name: target.sceneId ? (sceneNames.get(target.sceneId) ?? null) : null,
        };
      }),
      has_more: hasMore,
      next_cursor:
        hasMore && last ? { before: last.createdAt.toISOString(), before_id: last.id } : null,
    },
    { headers: { "cache-control": "no-store" } },
  );
}

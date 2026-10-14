import { and, gte, sql } from "drizzle-orm";
import { auditEvents } from "@frameos-cloud/db";
import { NextRequest, NextResponse } from "next/server";
import {
  activityConditions,
  histogramSpans,
  parseActivityFilters,
} from "../../../../../src/lib/account-activity";
import { jsonError, requireDatabase } from "../../../../../src/lib/device-flow";
import { rateLimitResponse } from "../../../../../src/lib/rate-limit";
import { readSession } from "../../../../../src/lib/session";

export const runtime = "nodejs";

// Event counts per time bucket for the activity page's chart. `span` picks
// the window (24h, 7d, 30d, 90d, all) and its bucket width; `q` and `group`
// narrow the events the same way the list does, so the bars and the rows
// agree. `from` / `to` are ignored here on purpose: the chart is what the
// reader drags on to choose them, so it always shows the whole span.
export async function GET(request: NextRequest) {
  const limited = await rateLimitResponse(request, "account:activity-histogram", {
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
  const spanKey = query.get("span") ?? "30d";
  const span = histogramSpans[spanKey];
  if (!span) {
    return jsonError("invalid_request", 400, { detail: "unknown span" });
  }
  const parsed = parseActivityFilters(query);
  if ("error" in parsed) {
    return jsonError("invalid_request", 400, { detail: parsed.error });
  }
  const { from: _from, to: _to, ...filters } = parsed.filters;
  void _from;
  void _to;

  const conditions = await activityConditions(db, accountId, filters);
  const now = new Date();
  // "All time" starts at the account's first event, rounded down to a
  // bucket, and widens its buckets so a years-old account still gets a chart
  // a drag can select on.
  let stepSeconds = span.stepSeconds;
  let fromSeconds: number;
  if (span.seconds === null) {
    const [first] = await db
      .select({
        epoch: sql<number | null>`extract(epoch from min(${auditEvents.createdAt}))::float8`,
      })
      .from(auditEvents)
      .where(and(...conditions));
    const firstAt = typeof first?.epoch === "number" ? new Date(first.epoch * 1000) : now;
    const totalSeconds = Math.max(0, (now.getTime() - firstAt.getTime()) / 1000);
    stepSeconds =
      totalSeconds <= 7 * 86400 ? 6 * 3600 : totalSeconds <= 120 * 86400 ? 86400 : 7 * 86400;
    fromSeconds = Math.floor(firstAt.getTime() / 1000 / stepSeconds) * stepSeconds;
  } else {
    fromSeconds =
      Math.floor((now.getTime() / 1000 - span.seconds) / stepSeconds) * stepSeconds;
  }
  const toSeconds = (Math.floor(now.getTime() / 1000 / stepSeconds) + 1) * stepSeconds;
  const from = new Date(fromSeconds * 1000);

  // The step is inlined, not bound: a bound value appears as a different
  // parameter in SELECT and GROUP BY, and Postgres then refuses to see the
  // two expressions as the same one. It is one of the integers above.
  const step = sql.raw(String(Math.trunc(stepSeconds)));
  const bucket = sql<string>`(floor(extract(epoch from ${auditEvents.createdAt}) / ${step}) * ${step})::bigint::text`;
  const rows = await db
    .select({ bucket, count: sql<number>`count(*)::int` })
    .from(auditEvents)
    .where(and(...conditions, gte(auditEvents.createdAt, from)))
    .groupBy(bucket);
  const counts = new Map(rows.map((row) => [Number(row.bucket), row.count]));

  const buckets: { count: number; start: string }[] = [];
  for (let start = fromSeconds; start < toSeconds; start += stepSeconds) {
    buckets.push({ count: counts.get(start) ?? 0, start: new Date(start * 1000).toISOString() });
  }
  return NextResponse.json(
    {
      buckets,
      from: from.toISOString(),
      step_seconds: stepSeconds,
      to: new Date(toSeconds * 1000).toISOString(),
    },
    { headers: { "cache-control": "no-store" } },
  );
}

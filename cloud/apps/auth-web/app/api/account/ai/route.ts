import { eq } from "drizzle-orm";
import {
  accountAiUsage,
  accountBalanceMicros,
  accountMarginBasisPoints,
  customerReceivableCode,
  listPlans,
  readAccountPlan,
  readBillingSettings,
  recentAccountAiTurns,
  utcDayWindow,
  utcMonthWindow,
} from "@frameos-cloud/ledger";
import { accounts } from "@frameos-cloud/db";
import { NextRequest, NextResponse } from "next/server";
import { recordAuditEvent } from "../../../../src/lib/audit";
import { csrfResponse } from "../../../../src/lib/csrf";
import {
  jsonError,
  readJsonObject,
  requireDatabase,
} from "../../../../src/lib/device-flow";
import { rateLimitResponse } from "../../../../src/lib/rate-limit";
import { readSession } from "../../../../src/lib/session";

export const runtime = "nodejs";

// The account's own view of its AI usage, and the switch that turns it off
// (cloud/docs/accounting-todo.md §5.1, §5.2).
//
// GET is everything /account/ai renders: this month and last, the breakdown
// by surface, the recent turns, the daily cap and where today stands against
// it, and the current plan. Deliberately its own route rather than more of
// /api/account/usage — that payload is the "can I still do X" answer an agent
// polls, and it has no business carrying a hundred turn rows.
//
// PUT flips the switch. Audited in both directions, because "when did AI stop
// working for me" is a support question and the answer has to be findable.

export async function GET(request: NextRequest) {
  const limited = await rateLimitResponse(request, "account:ai", {
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
  const { db, response } = requireDatabase();
  if (!db) {
    return response;
  }
  const accountId = session.accountId;
  const now = new Date();
  const dayWindow = utcDayWindow(now);
  const [[account], thisMonth, lastMonth, today, turns, settings, plan, plans, owed] =
    await Promise.all([
      db
        .select({ aiDisabledAt: accounts.aiDisabledAt })
        .from(accounts)
        .where(eq(accounts.id, accountId))
        .limit(1),
      accountAiUsage(db, accountId, utcMonthWindow(now)),
      accountAiUsage(db, accountId, utcMonthWindow(now, -1)),
      accountAiUsage(db, accountId, dayWindow),
      recentAccountAiTurns(db, accountId, { limit: 20 }),
      readBillingSettings(db),
      readAccountPlan(db, accountId),
      listPlans(db),
      // What the books say they owe — the receivable, which is what the
      // month-end invoice collects and the only number that includes a
      // subscription charge, a credit or a reversal (§9.2 item 11).
      accountBalanceMicros(db, customerReceivableCode(accountId)),
    ]);
  if (!account) {
    return jsonError("login_required", 401);
  }
  // ONE definition of the margin (plans.ts): the same function metering
  // prices with, so the page cannot name a rate the meter does not use.
  const marginBasisPoints = await accountMarginBasisPoints(db, accountId, settings);

  return NextResponse.json(
    {
      cap: {
        daily_micros: settings.dailyCapMicros.toString(),
        // When today's number goes back to zero. Named rather than implied:
        // "resets at midnight" is ambiguous in a way a timestamp is not
        // (§8.12 is the open question about whose midnight it should be).
        resets_at: dayWindow.until.toISOString(),
        today_micros: today.chargeableMicros.toString(),
      },
      balance: {
        // Positive = owed to us; negative = a credit in their favour.
        receivable_micros: owed.toString(),
      },
      enabled: account.aiDisabledAt === null,
      margin_basis_points: marginBasisPoints,
      // 'shadow' means measured and priced but charged to nobody. Every
      // number below is real; only the billing is not, and a UI that does not
      // say so is telling people they owe money they do not.
      metering_mode: settings.meteringMode,
      months: {
        current: serializeUsage(thisMonth),
        previous: serializeUsage(lastMonth),
      },
      plan: {
        cancel_at: plan.cancelAt?.toISOString() ?? null,
        code: plan.plan.code,
        margin_basis_points: plan.plan.marginBasisPoints,
        name: plan.plan.name,
        next_plan_code: plan.nextPlanCode,
        price_micros: plan.plan.priceMicros.toString(),
        subscribed: plan.subscribed,
      },
      plans: plans
        .filter((entry) => entry.public)
        .map((entry) => ({
          code: entry.code,
          description: entry.description,
          entitlements: entry.entitlements,
          margin_basis_points: entry.marginBasisPoints,
          name: entry.name,
          period: entry.period,
          price_micros: entry.priceMicros.toString(),
        })),
      turns: turns.map((turn) => ({
        chat_id: turn.chatId,
        credited: turn.credited,
        list_cost_micros: turn.listCostMicros.toString(),
        micros: turn.chargeableMicros.toString(),
        model: turn.model,
        occurred_at: turn.occurredAt.toISOString(),
        own_key: turn.ownKey,
        surface: turn.surface,
      })),
    },
    { headers: { "cache-control": "no-store" } },
  );
}

function serializeUsage(usage: Awaited<ReturnType<typeof accountAiUsage>>) {
  return {
    micros: usage.chargeableMicros.toString(),
    own_key_only: usage.ownKeyOnly,
    surfaces: usage.buckets.map((bucket) => ({
      credential_source: bucket.credentialSource,
      list_cost_micros: bucket.listCostMicros.toString(),
      micros: bucket.chargeableMicros.toString(),
      surface: bucket.surface,
      turns: bucket.turns,
    })),
    turns: usage.turns,
  };
}

export async function PUT(request: NextRequest) {
  const csrf = csrfResponse(request);
  if (csrf) {
    return csrf;
  }
  const limited = await rateLimitResponse(request, "account:ai-toggle", {
    limit: 30,
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
  const body = await readJsonObject(request);
  if (typeof body.enabled !== "boolean") {
    return jsonError("invalid_request", 400, {
      detail: "enabled must be true or false",
    });
  }

  const enabled = body.enabled;
  await db
    .update(accounts)
    // A timestamp rather than a boolean: "since when" is worth having for
    // free, and null is the only state that means "on".
    .set({ aiDisabledAt: enabled ? null : new Date() })
    .where(eq(accounts.id, session.accountId));

  await recordAuditEvent(db, {
    accountId: session.accountId,
    actor: { accountId: session.accountId, kind: "account" },
    eventType: enabled ? "account.ai_enabled" : "account.ai_disabled",
    target: { accountId: session.accountId, kind: "account" },
  });

  return NextResponse.json({ enabled }, { headers: { "cache-control": "no-store" } });
}

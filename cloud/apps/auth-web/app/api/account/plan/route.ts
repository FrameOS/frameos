import {
  cancelAccountPlan,
  listPlans,
  readAccountPlan,
  setAccountPlan,
} from "@frameos-cloud/ledger";
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

// Which plan an account is on (cloud/docs/accounting-todo.md §0.1, Phase 5).
//
// Self-service plan changes are gated behind FRAMEOS_CLOUD_PLANS_SELF_SERVE
// and default OFF, on purpose. Subscribing accrues a real receivable
// (§3.6's charge entry), and Phase 3b — the payment provider, the stored
// payment method, the month-end invoice — does not exist yet. Letting
// somebody subscribe today would run up a balance with no way to settle it,
// which is a worse failure than not offering the button: the ledger would be
// right and the customer would be stuck.
//
// Everything underneath is finished and tested, so switching this on is a
// deployment decision rather than a build. Until then an operator moves
// accounts by hand and the page shows the ladder without a buy button.
function selfServeEnabled(env: Record<string, string | undefined> = process.env) {
  const raw = (env.FRAMEOS_CLOUD_PLANS_SELF_SERVE ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

export async function GET(request: NextRequest) {
  const limited = await rateLimitResponse(request, "account:plan", {
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
  const [current, plans] = await Promise.all([
    readAccountPlan(db, session.accountId),
    listPlans(db),
  ]);
  return NextResponse.json(
    {
      cancel_at: current.cancelAt?.toISOString() ?? null,
      // A downgrade waits for the rollover; this names where it lands.
      next_plan_code: current.nextPlanCode,
      plan: {
        code: current.plan.code,
        margin_basis_points: current.plan.marginBasisPoints,
        name: current.plan.name,
        price_micros: current.plan.priceMicros.toString(),
      },
      plans: plans
        .filter((plan) => plan.public)
        .map((plan) => ({
          code: plan.code,
          description: plan.description,
          entitlements: plan.entitlements,
          margin_basis_points: plan.marginBasisPoints,
          name: plan.name,
          period: plan.period,
          price_micros: plan.priceMicros.toString(),
        })),
      self_serve: selfServeEnabled(),
      status: current.status,
      subscribed: current.subscribed,
    },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function PUT(request: NextRequest) {
  const csrf = csrfResponse(request);
  if (csrf) {
    return csrf;
  }
  const limited = await rateLimitResponse(request, "account:plan-change", {
    limit: 20,
    windowMs: 60 * 60 * 1000,
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
  const code = typeof body.plan === "string" ? body.plan.trim() : "";
  if (!code) {
    return jsonError("invalid_request", 400, { detail: "plan is required" });
  }

  const plans = await listPlans(db);
  const target = plans.find((plan) => plan.code === code);
  if (!target || !target.public) {
    return jsonError("unknown_plan", 404);
  }
  // Downgrading to the free plan is always allowed — refusing to let somebody
  // stop paying us would be an unpleasant thing to build. Only taking on a
  // charge is gated.
  if (!selfServeEnabled() && target.priceMicros > 0n) {
    return jsonError("plans_not_available", 503, {
      detail:
        "Paid plans are not open yet. Nothing is charged for AI while FrameOS Cloud AI is in preview.",
    });
  }

  if (target.priceMicros === 0n) {
    await cancelAccountPlan(db, session.accountId);
  } else {
    await setAccountPlan(db, session.accountId, target.code);
  }
  await recordAuditEvent(db, {
    accountId: session.accountId,
    actor: { accountId: session.accountId, kind: "account" },
    eventType:
      target.priceMicros === 0n ? "account.plan_canceled" : "account.plan_changed",
    metadata: { plan: target.code },
    target: { accountId: session.accountId, kind: "account" },
  });

  const current = await readAccountPlan(db, session.accountId);
  return NextResponse.json(
    {
      cancel_at: current.cancelAt?.toISOString() ?? null,
      next_plan_code: current.nextPlanCode,
      plan: { code: current.plan.code, name: current.plan.name },
      subscribed: current.subscribed,
    },
    { headers: { "cache-control": "no-store" } },
  );
}

import {
  cancelAccountPlan,
  fallbackPaygPlan,
  listPlans,
  paygPlanCode,
  readAccountPlan,
} from "@frameos-cloud/ledger";
import { NextRequest, NextResponse } from "next/server";
import { recordAuditEvent } from "../../../../src/lib/audit";
import { csrfResponse } from "../../../../src/lib/csrf";
import {
  jsonError,
  readJsonObject,
  requireDatabase,
} from "../../../../src/lib/device-flow";
import { getCloudBaseUrl, getPricingUrl } from "../../../../src/lib/env";
import { planCatalog } from "../../../../src/lib/plan-catalog";
import { rateLimitResponse } from "../../../../src/lib/rate-limit";
import { readSession } from "../../../../src/lib/session";
import { limitsForPlan } from "../../../../src/lib/usage";

export const runtime = "nodejs";

// Which plan an account is on, and the changes it may make to it
// (cloud/docs/billing.md, cloud/docs/accounting-todo.md §0.1).
//
// No payment provider is wired up, so a paid plan cannot be bought here: the
// cards say "contact support" and an operator moves accounts by hand (the
// admin plan route). What this route does let an account do is stop paying.
// `billing` and `purchasable` are the shape a provider adapter fills in.

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
  const free = plans.find((plan) => plan.code === paygPlanCode) ?? fallbackPaygPlan;
  return NextResponse.json(
    {
      // The payment provider's side: whether a card can be charged here, in
      // which mode, and the subscription it holds for this account. None yet.
      billing: { checkout: false, manage: false, mode: null, subscription: null },
      cancel_at: current.cancelAt?.toISOString() ?? null,
      // Free, Private and Business as the usage page draws them (plan-catalog.ts).
      // `plans` below is the billing_plans rows.
      catalog: planCatalog(limitsForPlan(free), current.plan.code),
      // Where the plan cards send someone who wants the long version.
      links: {
        pricing: getPricingUrl(),
        refunds: new URL("/legal/refunds", getCloudBaseUrl()).toString(),
      },
      // A downgrade waits for the renewal; this names where it lands.
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
      self_serve: false,
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
  // Taking on a charge is a decision for the person, in a browser, never a
  // script's bearer: the same line the frame-confirm and second-factor
  // routes draw.
  if (session.apiToken) {
    return jsonError("api_token_not_allowed", 403);
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
  const accountId = session.accountId;
  if (target.priceMicros > 0n) {
    return jsonError("plans_not_available", 503, {
      detail: "Paid plans cannot be bought here yet. Contact support to activate one.",
    });
  }
  // Stopping is always allowed: the plan runs to the end of the period
  // already charged for and ends there.
  await cancelAccountPlan(db, accountId);
  await recordAuditEvent(db, {
    accountId,
    actor: { accountId, kind: "account" },
    eventType: "account.plan_canceled",
    metadata: { plan: target.code },
    target: { accountId, kind: "account" },
  });

  const current = await readAccountPlan(db, accountId);
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

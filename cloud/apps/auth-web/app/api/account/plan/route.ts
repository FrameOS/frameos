import {
  cancelAccountPlan,
  fallbackPaygPlan,
  listPlans,
  paygPlanCode,
  readAccountPlan,
} from "@frameos-cloud/ledger";
import { NextRequest, NextResponse } from "next/server";
import { recordAuditEvent } from "../../../../src/lib/audit";
import {
  BillingError,
  billingSummary,
  cancelAtPeriodEnd,
  changePaidPlan,
  purchasablePlanCodes,
} from "../../../../src/lib/billing-provider";
import { csrfResponse } from "../../../../src/lib/csrf";
import {
  jsonError,
  readJsonObject,
  requireDatabase,
} from "../../../../src/lib/device-flow";
import { getCloudBaseUrl, getPricingUrl } from "../../../../src/lib/env";
import { reportError } from "../../../../src/lib/log";
import { planCatalog } from "../../../../src/lib/plan-catalog";
import { rateLimitResponse } from "../../../../src/lib/rate-limit";
import { readSession } from "../../../../src/lib/session";
import { StripeApiError, stripeSetup } from "../../../../src/lib/stripe";
import { accountIsSuperadmin } from "../../../../src/lib/superadmin";
import { limitsForPlan } from "../../../../src/lib/usage";

export const runtime = "nodejs";

// Which plan an account is on, and the changes it may make to it
// (cloud/docs/billing.md, cloud/docs/accounting-todo.md §0.1).
//
// A paid plan is bought at Stripe's checkout
// (POST /api/account/plan/checkout), which is the only way onto one from
// here. This route then moves a paying account between paid plans, takes a
// cancellation back, and cancels. With no provider set up nothing can be
// bought and the cards say "contact support"; an operator moves accounts by
// hand (the admin plan route).

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
  const setup = stripeSetup();
  const superadmin = await accountIsSuperadmin(session.accountId);
  const [current, plans, purchasable, billing] = await Promise.all([
    readAccountPlan(db, session.accountId),
    listPlans(db),
    purchasablePlanCodes(db, setup, superadmin),
    // Cloudflare's guess at the visitor's country, for "+ VAT" or "+ tax"
    // after a price. Checkout charges by the billing address.
    billingSummary(db, setup, session.accountId, superadmin, request.headers.get("cf-ipcountry")),
  ]);
  const free = plans.find((plan) => plan.code === paygPlanCode) ?? fallbackPaygPlan;
  return NextResponse.json(
    {
      // The payment provider's side: whether a card can be charged here, in
      // which mode, and the subscription it holds for this account.
      billing,
      cancel_at: current.cancelAt?.toISOString() ?? null,
      // Free, Private and Business as the usage page draws them (plan-catalog.ts).
      // `plans` below is the billing_plans rows.
      catalog: planCatalog(limitsForPlan(free), current.plan.code, purchasable),
      // Given by an operator without a payment: nothing bills it, and
      // `cancel_at` is the last moment it runs, if it ends.
      granted: current.granted,
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
      self_serve: billing.checkout,
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
  const setup = stripeSetup();
  const accountId = session.accountId;

  try {
    if (target.priceMicros === 0n) {
      // Stopping is always allowed. A plan the provider bills runs to the
      // end of the period paid for; one set by hand ends as it always did.
      const scheduled = setup.config ? await cancelAtPeriodEnd(db, setup.config, accountId) : false;
      if (!scheduled) {
        await cancelAccountPlan(db, accountId);
      }
    } else {
      if (!setup.config) {
        return jsonError("plans_not_available", 503, {
          detail: "Paid plans cannot be bought here yet. Contact support to activate one.",
        });
      }
      await changePaidPlan(db, setup.config, accountId, target.code);
    }
  } catch (error) {
    if (error instanceof BillingError) {
      return jsonError(error.code, error.status, { detail: error.message, ...error.extra });
    }
    if (error instanceof StripeApiError) {
      reportError("billing.plan_change_failed", error, { accountId, plan: target.code });
      return jsonError("payment_provider_failed", 502, {
        detail: "Stripe did not accept the change. Nothing was charged. Try again in a moment.",
      });
    }
    throw error;
  }
  await recordAuditEvent(db, {
    accountId,
    actor: { accountId, kind: "account" },
    eventType:
      target.priceMicros === 0n ? "account.plan_canceled" : "account.plan_changed",
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

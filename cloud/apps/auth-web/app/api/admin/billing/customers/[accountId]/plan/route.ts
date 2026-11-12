import { eq } from "drizzle-orm";
import { accounts, subscriptions } from "@frameos-cloud/db";
import {
  cancelAccountPlan,
  grantAccountPlan,
  grantedPlanProvider,
  LedgerError,
  readAccountPlan,
  readPlan,
  setAccountPlan,
} from "@frameos-cloud/ledger";
import { NextRequest, NextResponse } from "next/server";
import { getSuperadminContext, isUuid, superadminRefusal } from "../../../../../../../src/lib/admin";
import { recordAuditEvent } from "../../../../../../../src/lib/audit";
import { isAccountUuid } from "../../../../../../../src/lib/billing-admin";
import { csrfResponse } from "../../../../../../../src/lib/csrf";
import {
  jsonError,
  readJsonObject,
  requireDatabase,
} from "../../../../../../../src/lib/device-flow";
import { rateLimitResponse } from "../../../../../../../src/lib/rate-limit";
import { readSession } from "../../../../../../../src/lib/session";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ accountId: string }> };

// Putting an account on a plan by hand (cloud/docs/accounting-todo.md §9.3:
// "an operator moves accounts by hand" had no route). Same lifecycle the
// self-serve route drives — first period opened and charged now, upgrades
// prorated, downgrades at the rollover — with two operator-only differences:
//
//  - non-public plans are allowed. `billing_plans.public = false` rows exist
//    precisely for grandfathered or negotiated arrangements, and the only
//    way onto one is this route;
//  - no checkout. A plan set here is billed by the nightly cycle and runs
//    up a receivable nothing collects yet; an operator doing that on
//    purpose, with a reason on record, is what this route is for. A
//    customer buys a plan at the payment provider's checkout instead
//    (docs/billing.md).
//
// An account that pays through the payment provider is refused: its plan
// follows what the provider bills, and changing it here would either bill
// it twice or leave a card being charged for a plan it no longer has.
// Change or cancel the subscription in the provider's dashboard.
//
// Moving to the free plan is a cancellation: run-to-period-end by default
// (they owe for the period already charged and keep it), or `immediately`
// for the dunning case. Neither refunds on its own — §3.6's refund is a
// separate, deliberate act on the journal page.
//
// `grant: true` gives the plan without a payment instead (`grantAccountPlan`):
// nothing is charged or booked, and `until` (a date, the last day the plan
// runs, or an ISO instant) ends it; without it the grant runs until an
// operator changes it or the account buys a plan. The way onto a plan for
// App Review's demo account, a partner or a friend.
export async function PUT(request: NextRequest, context: RouteContext) {
  const csrf = csrfResponse(request);
  if (csrf) {
    return csrf;
  }
  const limited = await rateLimitResponse(request, "admin:billing-customer-plan", {
    limit: 60,
    windowMs: 15 * 60 * 1000,
  });
  if (limited) {
    return limited;
  }
  const admin = await getSuperadminContext({ mutation: true });
  if (admin.kind !== "ok") {
    return superadminRefusal(admin);
  }
  const { accountId } = await context.params;
  if (!isUuid(accountId)) {
    return jsonError("not_found", 404);
  }
  if (!isAccountUuid(accountId)) {
    return jsonError("not_found", 404);
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
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (!reason) {
    return jsonError("reason_required", 400, {
      detail: "Say why — a plan change by hand is a fact the books will ask about.",
    });
  }
  const immediately = body.immediately === true;
  const grant = body.grant === true;
  const until = grant ? parseUntil(body.until) : null;
  if (until === "invalid") {
    return jsonError("invalid_request", 400, {
      detail: "until must be a date (2026-12-31) or an ISO time",
    });
  }

  // The account must exist: a subscription row for a uuid nobody has is a
  // receivable nobody will ever pay, and the ledger would not notice.
  const [account] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  if (!account) {
    return jsonError("not_found", 404);
  }
  const target = await readPlan(db, code);
  if (!target) {
    return jsonError("unknown_plan", 404);
  }
  if (grant && target.priceMicros === 0n) {
    return jsonError("invalid_request", 400, {
      detail: "Only a paid plan can be given. Move the account to Free without a grant.",
    });
  }

  const before = await readAccountPlan(db, accountId);
  const [ours] = await db
    .select({ provider: subscriptions.provider, status: subscriptions.status })
    .from(subscriptions)
    .where(eq(subscriptions.accountId, accountId))
    .limit(1);
  if (
    before.subscribed &&
    ours?.provider &&
    ours.provider !== grantedPlanProvider &&
    ours.status !== "canceled"
  ) {
    return jsonError("billed_by_provider", 409, {
      detail: `This account pays for its plan through ${ours.provider}. Change or cancel the subscription in the provider's dashboard; the account follows it.`,
    });
  }
  try {
    if (grant) {
      await grantAccountPlan(db, accountId, target.code, { until });
    } else if (target.priceMicros === 0n) {
      await cancelAccountPlan(db, accountId, { immediately });
    } else {
      await setAccountPlan(db, accountId, target.code);
    }
  } catch (error) {
    if (error instanceof LedgerError) {
      return jsonError(error.code, 400, { detail: error.message });
    }
    throw error;
  }
  const after = await readAccountPlan(db, accountId);

  const session = await readSession();
  await recordAuditEvent(db, {
    accountId,
    actor: {
      accountId: admin.accountId,
      kind: "superadmin",
      providerSubject: session?.providerSubject,
    },
    eventType: grant
      ? "admin.plan_granted"
      : target.priceMicros === 0n
        ? "admin.plan_canceled"
        : "admin.plan_changed",
    metadata: {
      from: before.subscribed ? before.plan.code : null,
      ...(grant ? { until: until?.toISOString() ?? null } : { immediately }),
      plan: target.code,
      reason,
    },
    target: { accountId, kind: "account" },
  });

  return NextResponse.json(
    {
      cancel_at: after.cancelAt?.toISOString() ?? null,
      granted: after.granted,
      next_plan_code: after.nextPlanCode,
      plan: { code: after.plan.code, name: after.plan.name },
      subscribed: after.subscribed,
    },
    { headers: { "cache-control": "no-store" } },
  );
}

// The grant's end. A bare date is the last day the plan runs, so it ends at
// the start of the next day (UTC); anything else must parse as a time.
// Absent or empty: no end.
function parseUntil(value: unknown): Date | null | "invalid" {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (typeof value !== "string") {
    return "invalid";
  }
  const text = value.trim();
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const at = day
    ? new Date(Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3]) + 1))
    : new Date(text);
  return Number.isNaN(at.getTime()) ? "invalid" : at;
}

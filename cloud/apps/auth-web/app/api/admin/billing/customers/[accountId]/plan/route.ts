import { eq } from "drizzle-orm";
import { accounts } from "@frameos-cloud/db";
import {
  cancelAccountPlan,
  LedgerError,
  readAccountPlan,
  readPlan,
  setAccountPlan,
} from "@frameos-cloud/ledger";
import { NextRequest, NextResponse } from "next/server";
import { getSuperadminContext } from "../../../../../../../src/lib/admin";
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
//  - self-serve gating does not apply. The FRAMEOS_CLOUD_PLANS_SELF_SERVE
//    switch exists because a customer subscribing runs up a receivable
//    Phase 3b cannot yet settle; an operator doing it on purpose, with a
//    reason on record, is the exception that switch was written around.
//
// Moving to the free plan is a cancellation: run-to-period-end by default
// (they owe for the period already charged and keep it), or `immediately`
// for the dunning case. Neither refunds on its own — §3.6's refund is a
// separate, deliberate act on the journal page.
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
  const admin = await getSuperadminContext();
  if (admin.kind !== "ok") {
    return jsonError(
      admin.kind === "forbidden" ? "forbidden" : "unauthenticated",
      admin.kind === "forbidden" ? 403 : 401,
    );
  }
  const { accountId } = await context.params;
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

  const before = await readAccountPlan(db, accountId);
  try {
    if (target.priceMicros === 0n) {
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
    eventType:
      target.priceMicros === 0n ? "admin.plan_canceled" : "admin.plan_changed",
    metadata: {
      from: before.subscribed ? before.plan.code : null,
      immediately,
      plan: target.code,
      reason,
    },
    target: { accountId, kind: "account" },
  });

  return NextResponse.json(
    {
      cancel_at: after.cancelAt?.toISOString() ?? null,
      next_plan_code: after.nextPlanCode,
      plan: { code: after.plan.code, name: after.plan.name },
      subscribed: after.subscribed,
    },
    { headers: { "cache-control": "no-store" } },
  );
}

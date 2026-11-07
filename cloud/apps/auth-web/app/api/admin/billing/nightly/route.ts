import {
  checkLedgerIntegrity,
  dailySummary,
  readBillingSettings,
  runSubscriptionCycle,
  sweepUnpostedUsage,
} from "@frameos-cloud/ledger";
import { NextRequest, NextResponse } from "next/server";
import { authenticateJobToken } from "../../../../../src/lib/api-tokens";
import { csrfResponse } from "../../../../../src/lib/csrf";
import { jsonError, requireDatabase } from "../../../../../src/lib/device-flow";
import { logInfo, reportError } from "../../../../../src/lib/log";
import { rateLimitResponse } from "../../../../../src/lib/rate-limit";

export const runtime = "nodejs";
// A sweep of a night's backlog plus every invariant across the whole book;
// well under a second at our size, but not a request to cut off at thirty.
export const maxDuration = 300;

// The nightly accounting job, as an endpoint rather than a script.
//
// The invariants are already TypeScript (packages/ledger/src/integrity.ts) and
// they are the same code the test suite runs, which is the point: one
// definition of "the books are consistent", proven on fresh data by the suite
// and on production data by this. A bash-and-psql sibling of db-cleanup.sh
// would have meant a second copy of every query, drifting from the first.
//
// It runs here rather than as `tsx` on the server for a plain reason: the
// release bundle is Next's standalone output and carries no tsx (which is
// also why scripts/object-store-sweep.sh is bash). What ops has instead is
// scripts/accounting-nightly.sh, which curls this with a JOB token
// (`fc_apijob_…`, access `billing_nightly`, minted by
// scripts/accounting-service-account.sh on an account nobody can sign in
// as). That token opens this route and nothing else: it satisfies no
// readSession() gate, so it cannot read an account, post a journal entry or
// reach any other /api/admin/* route. It used to be a superadmin's personal
// token, which could do all of that from the ops box. No cookie session is
// accepted here either — a person runs the sweep by running the script.
//
// Three things happen, in order:
//   1. Sweep the usage records whose ledger entries never landed. Idempotent
//      by turn id, so a night that already posted is a no-op.
//   2. Run the subscription cycle: open the periods that are due, charge the
//      ones that have started, earn what the running ones have served so
//      far (daily recognition, §3.6), and close out the ones that have
//      ended. Idempotent on each period row, so a night that runs twice
//      charges nobody twice and a night that never ran is caught up rather
//      than skipped.
//   3. Run every invariant and report each violation. A violation is an
//      alert, not a failure to fix automatically: books that disagree with
//      themselves need a human, and quietly "correcting" them is how a
//      discrepancy becomes undiscoverable.
//
// The order matters for step 3: it must see the books AFTER everything that
// was going to be written tonight has been, or it reports a disagreement it
// caused itself.
export async function POST(request: NextRequest) {
  const csrf = csrfResponse(request);
  if (csrf) {
    return csrf;
  }
  const limited = await rateLimitResponse(request, "admin:billing-nightly", {
    limit: 12,
    windowMs: 60 * 60 * 1000,
  });
  if (limited) {
    return limited;
  }
  const { db, response } = requireDatabase();
  if (!db) {
    return response;
  }
  const job = await authenticateJobToken(
    db,
    request.headers.get("authorization"),
    "billing_nightly",
  );
  if (!job) {
    return jsonError("unauthenticated", 401);
  }

  const startedAt = Date.now();
  const settings = await readBillingSettings(db);
  const sweep = await sweepUnpostedUsage(db);
  for (const failure of sweep.failures) {
    reportError("billing.sweep_failed", failure.error, { turnId: failure.turnId });
  }

  const subscriptionCycle = await runSubscriptionCycle(db);
  for (const failure of subscriptionCycle.failures) {
    reportError("billing.subscription_cycle_failed", failure.error, {
      periodId: failure.periodId,
    });
  }
  // The cycle moved these accounts to the free plan because the plan they
  // were downgrading to has been deleted. Not an error in the books, but a
  // customer who asked for a plan and got none: somebody should offer them
  // the plan that replaced it.
  for (const missing of subscriptionCycle.missingDowngradePlans) {
    reportError(
      "billing.downgrade_plan_missing",
      new Error(`Downgrade to deleted plan ${missing.planCode}; moved to the free plan`),
      { ...missing },
    );
  }

  const violations = await checkLedgerIntegrity(db, {
    dailyCapMicros: settings.dailyCapMicros,
    overdraftMicros: settings.overdraftMicros,
    sharedKeyDailyCapMicros: settings.sharedKeyDailyCapMicros,
  });
  for (const violation of violations) {
    // One report per violation, not one for the batch: each is its own
    // problem and each deserves to be findable by its own check name.
    reportError(
      "billing.integrity_violation",
      new Error(`${violation.check}: ${violation.detail}`),
      { check: violation.check },
    );
  }

  const until = new Date();
  const since = new Date(until.getTime() - 24 * 60 * 60 * 1000);
  const summary = await dailySummary(db, { since, until });

  // The job token has a TTL (scripts/accounting-service-account.sh); the
  // script that called us warns while there is still time to rotate.
  const tokenExpiresInDays = job.token.expiresAt
    ? Math.floor((job.token.expiresAt.getTime() - until.getTime()) / (24 * 60 * 60 * 1000))
    : null;

  // The daily line, whether or not anything was wrong: a journal with a
  // number in it every night is how a missing night gets noticed.
  logInfo("billing.nightly", {
    apiTokenId: job.token.id,
    cogsMicros: summary.cogsMicros.toString(),
    contraRevenueMicros: summary.contraRevenueMicros.toString(),
    customerLiabilityMicros: summary.customerLiabilityMicros.toString(),
    customerReceivableMicros: summary.customerReceivableMicros.toString(),
    durationMs: Date.now() - startedAt,
    marginMicros: summary.marginMicros.toString(),
    meteringMode: settings.meteringMode,
    netRevenueMicros: summary.netRevenueMicros.toString(),
    revenueMicros: summary.revenueMicros.toString(),
    subscriptionsAccrued: subscriptionCycle.accrued,
    subscriptionsAccruedMicros: subscriptionCycle.accruedMicros.toString(),
    subscriptionsCharged: subscriptionCycle.charged,
    subscriptionsFailed: subscriptionCycle.failures.length,
    subscriptionsOpened: subscriptionCycle.opened,
    subscriptionsRecognized: subscriptionCycle.recognized,
    sweepFailed: sweep.failures.length,
    sweepPosted: sweep.posted,
    tokenExpiresInDays,
    violations: violations.length,
  });

  const ok =
    violations.length === 0 &&
    sweep.failures.length === 0 &&
    subscriptionCycle.failures.length === 0 &&
    subscriptionCycle.missingDowngradePlans.length === 0;

  return NextResponse.json({
    // What scripts/accounting-nightly.sh pings the dead-man check with: the
    // counts and the names of the broken checks, and no amount. The ping
    // goes to a third party (healthchecks.io), and the night's revenue is
    // not theirs to read; the full body stays in the journal on the box.
    healthcheck: healthcheckLine({
      missingDowngradePlans: subscriptionCycle.missingDowngradePlans.length,
      ok,
      subscriptionsCharged: subscriptionCycle.charged,
      subscriptionsFailed: subscriptionCycle.failures.length,
      subscriptionsOpened: subscriptionCycle.opened,
      sweepFailed: sweep.failures.length,
      sweepPosted: sweep.posted,
      violations: violations.map((violation) => violation.check),
    }),
    metering_mode: settings.meteringMode,
    ok,
    summary: {
      cogs_micros: summary.cogsMicros.toString(),
      contra_revenue_micros: summary.contraRevenueMicros.toString(),
      customer_liability_micros: summary.customerLiabilityMicros.toString(),
      customer_receivable_micros: summary.customerReceivableMicros.toString(),
      margin_micros: summary.marginMicros.toString(),
      net_revenue_micros: summary.netRevenueMicros.toString(),
      revenue_micros: summary.revenueMicros.toString(),
      since: since.toISOString(),
      until: until.toISOString(),
    },
    subscriptions: {
      accrued: subscriptionCycle.accrued,
      accrued_micros: subscriptionCycle.accruedMicros.toString(),
      charged: subscriptionCycle.charged,
      failed: subscriptionCycle.failures.length,
      missing_downgrade_plans: subscriptionCycle.missingDowngradePlans.map((missing) => ({
        account_id: missing.accountId,
        plan_code: missing.planCode,
      })),
      opened: subscriptionCycle.opened,
      recognized: subscriptionCycle.recognized,
    },
    sweep: {
      failed: sweep.failures.length,
      posted: sweep.posted,
      scanned: sweep.scanned,
    },
    token_expires_at: job.token.expiresAt?.toISOString() ?? null,
    token_expires_in_days: tokenExpiresInDays,
    violations: violations.map((violation) => ({
      check: violation.check,
      detail: violation.detail,
    })),
  });
}

// One line, plain ASCII, no quotes: the script lifts it out of the JSON with
// sed (there is no jq on the box). Check names are identifiers.
function healthcheckLine(input: {
  missingDowngradePlans: number;
  ok: boolean;
  subscriptionsCharged: number;
  subscriptionsFailed: number;
  subscriptionsOpened: number;
  sweepFailed: number;
  sweepPosted: number;
  violations: string[];
}): string {
  const parts = [
    input.ok ? "ok" : "attention",
    `sweep posted=${input.sweepPosted} failed=${input.sweepFailed}`,
    `subscriptions opened=${input.subscriptionsOpened} charged=${input.subscriptionsCharged} failed=${input.subscriptionsFailed}`,
    `violations=${input.violations.length}`,
  ];
  if (input.violations.length > 0) {
    parts.push(`checks=${[...new Set(input.violations)].join(",")}`);
  }
  if (input.missingDowngradePlans > 0) {
    parts.push(`downgrades_to_deleted_plans=${input.missingDowngradePlans}`);
  }
  return parts.join("; ").replace(/[^ -~]|["\\]/g, "");
}

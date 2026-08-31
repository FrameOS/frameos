import {
  checkLedgerIntegrity,
  dailySummary,
  readBillingSettings,
  sweepUnpostedUsage,
} from "@frameos-cloud/ledger";
import { NextRequest, NextResponse } from "next/server";
import { getSuperadminContext } from "../../../../../src/lib/admin";
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
// scripts/accounting-nightly.sh, which curls this with a superadmin API
// token — an existing auth mechanism rather than a new shared secret.
//
// Two things happen, in order:
//   1. Sweep the usage records whose ledger entries never landed. Idempotent
//      by turn id, so a night that already posted is a no-op.
//   2. Run every invariant and report each violation. A violation is an
//      alert, not a failure to fix automatically: books that disagree with
//      themselves need a human, and quietly "correcting" them is how a
//      discrepancy becomes undiscoverable.
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
  const admin = await getSuperadminContext();
  if (admin.kind !== "ok") {
    return jsonError(
      admin.kind === "forbidden" ? "forbidden" : "unauthenticated",
      admin.kind === "forbidden" ? 403 : 401,
    );
  }
  const { db, response } = requireDatabase();
  if (!db) {
    return response;
  }

  const startedAt = Date.now();
  const settings = await readBillingSettings(db);
  const sweep = await sweepUnpostedUsage(db);
  for (const failure of sweep.failures) {
    reportError("billing.sweep_failed", failure.error, { turnId: failure.turnId });
  }

  const violations = await checkLedgerIntegrity(db, {
    overdraftMicros: settings.overdraftMicros,
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

  // The daily line, whether or not anything was wrong: a journal with a
  // number in it every night is how a missing night gets noticed.
  logInfo("billing.nightly", {
    cogsMicros: summary.cogsMicros.toString(),
    contraRevenueMicros: summary.contraRevenueMicros.toString(),
    customerLiabilityMicros: summary.customerLiabilityMicros.toString(),
    durationMs: Date.now() - startedAt,
    marginMicros: summary.marginMicros.toString(),
    meteringMode: settings.meteringMode,
    netRevenueMicros: summary.netRevenueMicros.toString(),
    revenueMicros: summary.revenueMicros.toString(),
    sweepFailed: sweep.failures.length,
    sweepPosted: sweep.posted,
    violations: violations.length,
  });

  return NextResponse.json({
    metering_mode: settings.meteringMode,
    ok: violations.length === 0 && sweep.failures.length === 0,
    summary: {
      cogs_micros: summary.cogsMicros.toString(),
      contra_revenue_micros: summary.contraRevenueMicros.toString(),
      customer_liability_micros: summary.customerLiabilityMicros.toString(),
      margin_micros: summary.marginMicros.toString(),
      net_revenue_micros: summary.netRevenueMicros.toString(),
      revenue_micros: summary.revenueMicros.toString(),
      since: since.toISOString(),
      until: until.toISOString(),
    },
    sweep: {
      failed: sweep.failures.length,
      posted: sweep.posted,
      scanned: sweep.scanned,
    },
    violations: violations.map((violation) => ({
      check: violation.check,
      detail: violation.detail,
    })),
  });
}

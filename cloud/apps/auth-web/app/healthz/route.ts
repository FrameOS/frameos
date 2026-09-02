import { sql } from "drizzle-orm";
import { createDb } from "@frameos-cloud/db";
import { NextResponse } from "next/server";
import { hasDatabaseUrl } from "../../src/lib/env";
import { logError } from "../../src/lib/log";

// Liveness + readiness for auth-web, matching frame-hub's /healthz. The
// uptime check (ops/monitoring/uptime-check.sh) hits this; before it existed
// the check curl'd /login, which is a page the App Router will happily render
// with a dead database — so the one failure mode most worth alerting on was
// exactly the one the monitor could not see.
//
// "Ready" here means the request path a user hits actually works end to end:
// the process is up AND it can reach Postgres. Anything less is a liveness
// probe pretending to be a health check.

export const dynamic = "force-dynamic";
export const revalidate = 0;

// Short on purpose. A database that takes longer than this to answer
// `select 1` is not serving pages either, and the monitor's own timeout is
// 15s — this has to fail well inside it to return a useful 503 rather than
// hanging until curl gives up.
const databaseTimeoutMs = 3000;

async function checkDatabase() {
  if (!hasDatabaseUrl()) {
    return { detail: "DATABASE_URL is not set", ok: false };
  }
  const startedAt = Date.now();
  try {
    await Promise.race([
      createDb().execute(sql`select 1`),
      new Promise((_resolve, reject) =>
        setTimeout(
          () => reject(new Error(`timed out after ${databaseTimeoutMs}ms`)),
          databaseTimeoutMs,
        ),
      ),
    ]);
    return { latencyMs: Date.now() - startedAt, ok: true };
  } catch (error) {
    return {
      detail: error instanceof Error ? error.message : "unknown error",
      latencyMs: Date.now() - startedAt,
      ok: false,
    };
  }
}

export async function GET() {
  const database = await checkDatabase();

  if (!database.ok) {
    // Not reportError: a database outage would fire one PostHog exception per
    // probe, every five minutes, for the whole outage — and PostHog is
    // reached over the same network that is already in question. The
    // structured line plus the failing uptime check is the alert.
    logError("healthz.database_unavailable", { detail: database.detail });
  }

  // The driver's message (host names, the user, sometimes the query) stays
  // in the log; the unauthenticated probe only learns that the database is
  // the failing check.
  const checks = {
    database: database.ok
      ? database
      : { detail: "database_unavailable", latencyMs: database.latencyMs, ok: false },
  };

  return NextResponse.json(
    {
      checks,
      status: database.ok ? "ok" : "degraded",
      // Optional, and nothing sets it automatically: the deploy writes the
      // SHA to /opt/frameos-cloud/RELEASE as a file, not into the unit's
      // environment. Add it to /etc/frameos-cloud/auth-web.env by hand (or
      // teach frameos-cloud-update to rewrite it) if you want the monitor to
      // report which release answered. Omitted from the payload when unset.
      version: process.env.FRAMEOS_CLOUD_RELEASE?.trim() || undefined,
    },
    {
      headers: { "cache-control": "no-store, max-age=0" },
      status: database.ok ? 200 : 503,
    },
  );
}

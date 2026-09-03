import { createDb } from "@frameos-cloud/db";
import { NextResponse } from "next/server";
import { buildAccountExport } from "../../../../src/lib/account-export";
import { recordAuditEvent } from "../../../../src/lib/audit";
import { assertDatabaseUrlConfigured } from "../../../../src/lib/env";
import { identityRateLimitResponse } from "../../../../src/lib/rate-limit";
import { readSession } from "../../../../src/lib/session";

// GDPR art. 20: your data, in a machine-readable format, on demand. A GET so
// it can be an ordinary download link.
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await readSession();
  const accountId = session?.accountId;
  if (!accountId) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  // The export is the whole account in one file. A read-only token is the
  // credential handed to a dashboard or a script that may only look at
  // frames and scenes; it does not get the audit trail, the identities and
  // the settings list in one download.
  if (session.apiToken?.access === "read_only") {
    return NextResponse.json({ error: "read_only_token" }, { status: 403 });
  }

  // Building an export scans every table this account touches. Keyed on the
  // account rather than the IP, so one user cannot make the database
  // miserable by holding down a refresh key, and so a shared office IP does
  // not lock everyone else out of their own export.
  const limited = await identityRateLimitResponse(accountId, "account:export", {
    limit: 5,
    windowMs: 60 * 60 * 1000,
  });
  if (limited) {
    return limited;
  }

  assertDatabaseUrlConfigured();
  const db = createDb();
  const data = await buildAccountExport(db, accountId);
  if (!data) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  await recordAuditEvent(db, {
    accountId,
    actor: { accountId },
    eventType: "account.data_exported",
  });

  const stamp = new Date().toISOString().slice(0, 10);
  return new NextResponse(JSON.stringify(data, null, 2), {
    headers: {
      "cache-control": "no-store, max-age=0",
      "content-disposition": `attachment; filename="frameos-cloud-export-${stamp}.json"`,
      "content-type": "application/json; charset=utf-8",
    },
  });
}

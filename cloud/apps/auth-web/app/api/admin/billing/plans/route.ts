import { NextRequest, NextResponse } from "next/server";
import { getSuperadminContext, superadminRefusal } from "../../../../../src/lib/admin";
import { recordAuditEvent } from "../../../../../src/lib/audit";
import { csrfResponse } from "../../../../../src/lib/csrf";
import { requireDatabase } from "../../../../../src/lib/device-flow";
import { syncPlanRows } from "../../../../../src/lib/plan-rows";
import { rateLimitResponse } from "../../../../../src/lib/rate-limit";

export const runtime = "nodejs";

// "Sync plans" on /admin/billing/customers: write the catalog's self-serve
// stops as billing_plans rows (src/lib/plan-rows.ts). Safe to press again.
export async function POST(request: NextRequest) {
  const csrf = csrfResponse(request);
  if (csrf) {
    return csrf;
  }
  const limited = await rateLimitResponse(request, "admin:billing-plans-sync", {
    limit: 20,
    windowMs: 15 * 60 * 1000,
  });
  if (limited) {
    return limited;
  }
  const admin = await getSuperadminContext({ mutation: true });
  if (admin.kind !== "ok") {
    return superadminRefusal(admin);
  }
  const { db, response } = requireDatabase();
  if (!db) {
    return response;
  }
  const codes = await syncPlanRows(db);
  await recordAuditEvent(db, {
    accountId: admin.accountId,
    actor: { accountId: admin.accountId, kind: "superadmin" },
    eventType: "admin.billing_plans_synced",
    metadata: { plans: codes },
  });
  return NextResponse.json({ plans: codes }, { headers: { "cache-control": "no-store" } });
}

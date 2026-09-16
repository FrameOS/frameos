import { createDb } from "@frameos-cloud/db";
import { NextRequest, NextResponse } from "next/server";
import { getSuperadminContext, superadminRefusal } from "../../../../../src/lib/admin";
import { csrfResponse } from "../../../../../src/lib/csrf";
import { assertDatabaseUrlConfigured } from "../../../../../src/lib/env";
import { rateLimitResponse } from "../../../../../src/lib/rate-limit";
import { refreshAccountStorageUsage } from "../../../../../src/lib/storage-usage";

// Re-measure every account's storage now. Read-only work — it writes only the
// account_storage_usage cache — but it is expensive enough to be worth a rate
// limit and a superadmin check, and it is a POST because it changes state the
// next page load reads.
export async function POST(request: NextRequest) {
  const csrf = csrfResponse(request);
  if (csrf) {
    return csrf;
  }

  const limited = await rateLimitResponse(request, "admin:storage-refresh", {
    limit: 10,
    windowMs: 15 * 60 * 1000,
  });
  if (limited) {
    return limited;
  }

  // No `mutation: true`: this rewrites a cache of numbers the admin can
  // already read, so sending them back through /login/reauth to press a
  // refresh button would be ceremony without a threat behind it.
  const admin = await getSuperadminContext();
  if (admin.kind !== "ok") {
    return superadminRefusal(admin);
  }

  assertDatabaseUrlConfigured();
  const result = await refreshAccountStorageUsage(createDb());
  return NextResponse.json({
    accounts: result.accounts,
    computed_at: result.computedAt.toISOString(),
    duration_ms: result.durationMs,
    failed: result.failed,
  });
}

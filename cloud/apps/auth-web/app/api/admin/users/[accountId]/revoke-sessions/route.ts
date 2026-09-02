import { eq } from "drizzle-orm";
import {
  accounts,
  createDb,
  revokeApiTokensForAccount,
  revokeSessionsForAccount,
} from "@frameos-cloud/db";
import { recordAuditEvent } from "../../../../../../src/lib/audit";
import { NextRequest, NextResponse } from "next/server";
import {
  getSuperadminContext,
  isUuid,
  superadminRefusal,
} from "../../../../../../src/lib/admin";
import { csrfResponse } from "../../../../../../src/lib/csrf";
import { assertDatabaseUrlConfigured } from "../../../../../../src/lib/env";
import { rateLimitResponse } from "../../../../../../src/lib/rate-limit";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ accountId: string }> },
) {
  const csrf = csrfResponse(request);
  if (csrf) {
    return csrf;
  }

  const limited = await rateLimitResponse(request, "admin:users", {
    limit: 30,
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
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  assertDatabaseUrlConfigured();
  const db = createDb();
  const [target] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);

  if (!target) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // "Sign out everywhere" means every credential that stands in for the
  // person, and a personal API token is one: an admin revoking a
  // compromised account must not leave its scripts' bearer alive.
  await revokeSessionsForAccount(db, accountId);
  await revokeApiTokensForAccount(db, accountId);
  await recordAuditEvent(db, {
    accountId,
    actor: { accountId: admin.accountId },
    eventType: "admin.sessions_revoked",
    target: { accountId },
  });

  return NextResponse.json({ ok: true });
}

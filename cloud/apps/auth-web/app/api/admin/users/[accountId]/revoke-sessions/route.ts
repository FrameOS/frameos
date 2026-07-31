import { eq } from "drizzle-orm";
import {
  accounts,
  createDb,
  revokeSessionsForAccount,
} from "@frameos-cloud/db";
import { recordAuditEvent } from "../../../../../../src/lib/audit";
import { NextRequest, NextResponse } from "next/server";
import { getSuperadminContext } from "../../../../../../src/lib/admin";
import { csrfResponse } from "../../../../../../src/lib/csrf";
import { assertDatabaseUrlConfigured } from "../../../../../../src/lib/env";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ accountId: string }> },
) {
  const csrf = csrfResponse(request);
  if (csrf) {
    return csrf;
  }

  const admin = await getSuperadminContext();
  if (admin.kind !== "ok") {
    return NextResponse.json(
      { error: admin.kind },
      { status: admin.kind === "unauthenticated" ? 401 : 403 },
    );
  }

  const { accountId } = await context.params;
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

  await revokeSessionsForAccount(db, accountId);
  await recordAuditEvent(db, {
    accountId,
    actor: { accountId: admin.accountId },
    eventType: "admin.sessions_revoked",
    target: { accountId },
  });

  return NextResponse.json({ ok: true });
}

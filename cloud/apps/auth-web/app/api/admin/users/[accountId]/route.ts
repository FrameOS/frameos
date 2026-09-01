import { eq } from "drizzle-orm";
import {
  accounts,
  createDb,
} from "@frameos-cloud/db";
import { closeOutSubscriptionForDeletedAccount } from "@frameos-cloud/ledger";
import { recordAuditEvent } from "../../../../../src/lib/audit";
import { NextRequest, NextResponse } from "next/server";
import { getSuperadminContext } from "../../../../../src/lib/admin";
import { csrfResponse } from "../../../../../src/lib/csrf";
import { assertDatabaseUrlConfigured } from "../../../../../src/lib/env";

type RouteContext = { params: Promise<{ accountId: string }> };

function forbidden(kind: "unauthenticated" | "forbidden") {
  return NextResponse.json(
    { error: kind },
    { status: kind === "unauthenticated" ? 401 : 403 },
  );
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  const csrf = csrfResponse(request);
  if (csrf) {
    return csrf;
  }

  const admin = await getSuperadminContext();
  if (admin.kind !== "ok") {
    return forbidden(admin.kind);
  }

  const { accountId } = await context.params;
  const body = (await request.json().catch(() => undefined)) as
    | { is_superadmin?: unknown }
    | undefined;
  if (typeof body?.is_superadmin !== "boolean") {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  // Admins cannot change their own flag: revoking it would lock the panel
  // door behind them, and granting it to yourself is meaningless.
  if (accountId === admin.accountId) {
    return NextResponse.json({ error: "cannot_change_self" }, { status: 400 });
  }

  assertDatabaseUrlConfigured();
  const db = createDb();
  const [updated] = await db
    .update(accounts)
    .set({ isSuperadmin: body.is_superadmin, updatedAt: new Date() })
    .where(eq(accounts.id, accountId))
    .returning({ id: accounts.id });

  if (!updated) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  await recordAuditEvent(db, {
    accountId,
    actor: { accountId: admin.accountId },
    eventType: body.is_superadmin
      ? "admin.superadmin_granted"
      : "admin.superadmin_revoked",
    target: { accountId },
  });

  return NextResponse.json({ ok: true });
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  const csrf = csrfResponse(request);
  if (csrf) {
    return csrf;
  }

  const admin = await getSuperadminContext();
  if (admin.kind !== "ok") {
    return forbidden(admin.kind);
  }

  const { accountId } = await context.params;
  if (accountId === admin.accountId) {
    return NextResponse.json({ error: "cannot_delete_self" }, { status: 400 });
  }

  assertDatabaseUrlConfigured();
  const db = createDb();
  // Books first (cloud/docs/accounting-todo.md §9.2 item 4): a subscription
  // in progress returns its unearned remainder to the receivable and ends,
  // so deleting the account cannot strand deferred revenue.
  await closeOutSubscriptionForDeletedAccount(db, accountId);
  const [deleted] = await db
    .delete(accounts)
    .where(eq(accounts.id, accountId))
    .returning({ id: accounts.id, primaryEmail: accounts.primaryEmail });

  if (!deleted) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // The audit row survives account deletion because account_id is
  // set-null-on-delete; record the email in the payload for traceability.
  await recordAuditEvent(db, {
    actor: { accountId: admin.accountId },
    eventType: "admin.account_deleted",
    metadata: { email: deleted.primaryEmail },
    target: { accountId },
  });

  return NextResponse.json({ ok: true });
}

// Rename (PATCH) or remove (DELETE, with weakening proof) one passkey.
import { and, eq } from "drizzle-orm";
import { accountPasskeys } from "@frameos-cloud/db";
import { NextRequest, NextResponse } from "next/server";
import {
  accountSecurityContext,
  readJsonBody,
  requireWeakeningProof,
} from "../../../../../../src/lib/account-security";
import { recordAuditEvent } from "../../../../../../src/lib/audit";
import { requireDatabase } from "../../../../../../src/lib/device-flow";
import { clearRecoveryCodesIfNoFactors } from "../../../../../../src/lib/two-factor";
import { normalizePasskeyName } from "../../../../../../src/lib/webauthn";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ passkeyId: string }> },
) {
  const { db, response } = requireDatabase();
  if (!db) {
    return response;
  }
  const context = await accountSecurityContext(request, db, {
    action: "two-factor-passkeys",
    mutating: true,
  });
  if ("response" in context) {
    return context.response;
  }
  const { passkeyId } = await params;
  if (!uuidPattern.test(passkeyId)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const body = await readJsonBody(request);
  const name = normalizePasskeyName(body?.name, "");
  if (!name) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const updated = await db
    .update(accountPasskeys)
    .set({ name })
    .where(
      and(
        eq(accountPasskeys.id, passkeyId),
        eq(accountPasskeys.accountId, context.accountId),
      ),
    )
    .returning({ id: accountPasskeys.id });
  if (updated.length === 0) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  await recordAuditEvent(db, {
    accountId: context.accountId,
    actor: {
      accountId: context.accountId,
      providerSubject: context.providerSubject,
    },
    eventType: "account.passkey_renamed",
    metadata: { name },
    target: { passkeyId },
  });
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ passkeyId: string }> },
) {
  const { db, response } = requireDatabase();
  if (!db) {
    return response;
  }
  const context = await accountSecurityContext(request, db, {
    action: "two-factor-passkeys",
    mutating: true,
  });
  if ("response" in context) {
    return context.response;
  }
  const { passkeyId } = await params;
  if (!uuidPattern.test(passkeyId)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const body = await readJsonBody(request);
  const denied = await requireWeakeningProof(db, context, body);
  if (denied) {
    return denied;
  }
  const deleted = await db
    .delete(accountPasskeys)
    .where(
      and(
        eq(accountPasskeys.id, passkeyId),
        eq(accountPasskeys.accountId, context.accountId),
      ),
    )
    .returning({ name: accountPasskeys.name });
  if (deleted.length === 0) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const status = await clearRecoveryCodesIfNoFactors(db, context.accountId);
  await recordAuditEvent(db, {
    accountId: context.accountId,
    actor: {
      accountId: context.accountId,
      providerSubject: context.providerSubject,
    },
    eventType: "account.passkey_removed",
    metadata: { name: deleted[0]?.name },
    target: { passkeyId },
  });
  if (!status.enabled) {
    await recordAuditEvent(db, {
      accountId: context.accountId,
      actor: {
        accountId: context.accountId,
        providerSubject: context.providerSubject,
      },
      eventType: "account.two_factor_disabled",
      metadata: { method: "passkey" },
    });
  }
  return NextResponse.json({ ok: true, two_factor_enabled: status.enabled });
}

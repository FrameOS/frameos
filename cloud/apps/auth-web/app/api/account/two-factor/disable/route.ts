// Turns two-factor off entirely: authenticator, every passkey and the
// recovery codes go. Needs the weakening proof.
import { eq } from "drizzle-orm";
import {
  accountPasskeys,
  accountRecoveryCodes,
  accountTotp,
} from "@frameos-cloud/db";
import { NextRequest, NextResponse } from "next/server";
import {
  accountSecurityContext,
  readJsonBody,
  requireWeakeningProof,
} from "../../../../../src/lib/account-security";
import { recordAuditEvent } from "../../../../../src/lib/audit";
import { requireDatabase } from "../../../../../src/lib/device-flow";

export async function POST(request: NextRequest) {
  const { db, response } = requireDatabase();
  if (!db) {
    return response;
  }
  const context = await accountSecurityContext(request, db, {
    action: "two-factor-disable",
    limit: 10,
    mutating: true,
  });
  if ("response" in context) {
    return context.response;
  }
  const body = await readJsonBody(request);
  const denied = await requireWeakeningProof(db, context, body);
  if (denied) {
    return denied;
  }
  await db.transaction(async (tx) => {
    await tx
      .delete(accountTotp)
      .where(eq(accountTotp.accountId, context.accountId));
    await tx
      .delete(accountPasskeys)
      .where(eq(accountPasskeys.accountId, context.accountId));
    await tx
      .delete(accountRecoveryCodes)
      .where(eq(accountRecoveryCodes.accountId, context.accountId));
  });
  await recordAuditEvent(db, {
    accountId: context.accountId,
    actor: {
      accountId: context.accountId,
      providerSubject: context.providerSubject,
    },
    eventType: "account.two_factor_disabled",
    metadata: { method: "all" },
  });
  return NextResponse.json({ ok: true, two_factor_enabled: false });
}

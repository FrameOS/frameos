// Confirms authenticator enrollment with one valid code. The first second
// factor on the account also mints the recovery codes, returned exactly once.
import { revokeApiTokensForAccount } from "@frameos-cloud/db";
import { NextRequest, NextResponse } from "next/server";
import {
  accountSecurityContext,
  notifySecurityChange,
  readJsonBody,
} from "../../../../../../src/lib/account-security";
import { recordAuditEvent } from "../../../../../../src/lib/audit";
import { requireDatabase } from "../../../../../../src/lib/device-flow";
import {
  confirmTotpEnrollment,
  normalizeTotpCode,
  regenerateRecoveryCodes,
  secondFactorStatus,
} from "../../../../../../src/lib/two-factor";

export async function POST(request: NextRequest) {
  const { db, response } = requireDatabase();
  if (!db) {
    return response;
  }
  const context = await accountSecurityContext(request, db, {
    action: "two-factor-totp-confirm",
    limit: 15,
    mutating: true,
    recentAuth: true,
  });
  if ("response" in context) {
    return context.response;
  }
  const body = await readJsonBody(request);
  const code = normalizeTotpCode(body?.code);
  if (!code) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const before = await secondFactorStatus(db, context.accountId);
  const confirmed = await confirmTotpEnrollment(db, context.accountId, code);
  if (!confirmed) {
    return NextResponse.json({ error: "invalid_code" }, { status: 400 });
  }
  const recoveryCodes =
    before.enabled && before.recoveryCodesRemaining > 0
      ? undefined
      : await regenerateRecoveryCodes(db, context.accountId);
  // A personal API token never answers a second factor, so every one minted
  // before this moment would keep walking past the factor just enrolled.
  // Revoke them all; the owner re-mints from /account/developer, which asks
  // for fresh credentials and is now behind 2FA.
  const apiTokensRevoked = await revokeApiTokensForAccount(db, context.accountId);
  await recordAuditEvent(db, {
    accountId: context.accountId,
    actor: {
      accountId: context.accountId,
      providerSubject: context.providerSubject,
    },
    eventType: "account.totp_enabled",
    metadata: { apiTokensRevoked, method: "totp" },
  });
  await notifySecurityChange(context, "totp_enabled");
  return NextResponse.json({
    api_tokens_revoked: apiTokensRevoked,
    ok: true,
    ...(recoveryCodes ? { recovery_codes: recoveryCodes } : {}),
  });
}


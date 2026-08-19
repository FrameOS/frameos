// Confirms authenticator enrollment with one valid code. The first second
// factor on the account also mints the recovery codes, returned exactly once.
import { NextRequest, NextResponse } from "next/server";
import {
  accountSecurityContext,
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
  await recordAuditEvent(db, {
    accountId: context.accountId,
    actor: {
      accountId: context.accountId,
      providerSubject: context.providerSubject,
    },
    eventType: "account.totp_enabled",
    metadata: { method: "totp" },
  });
  return NextResponse.json({
    ok: true,
    ...(recoveryCodes ? { recovery_codes: recoveryCodes } : {}),
  });
}


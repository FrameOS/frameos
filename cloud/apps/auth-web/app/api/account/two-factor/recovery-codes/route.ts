// Regenerates the recovery codes (needs the weakening proof: a fresh set
// invalidates the old one, which is exactly what an attacker with a session
// would want). Returned exactly once.
import { NextRequest, NextResponse } from "next/server";
import {
  accountSecurityContext,
  readJsonBody,
  requireWeakeningProof,
} from "../../../../../src/lib/account-security";
import { recordAuditEvent } from "../../../../../src/lib/audit";
import { requireDatabase } from "../../../../../src/lib/device-flow";
import {
  regenerateRecoveryCodes,
  secondFactorStatus,
} from "../../../../../src/lib/two-factor";

export async function POST(request: NextRequest) {
  const { db, response } = requireDatabase();
  if (!db) {
    return response;
  }
  const context = await accountSecurityContext(request, db, {
    action: "two-factor-recovery",
    limit: 10,
    mutating: true,
  });
  if ("response" in context) {
    return context.response;
  }
  const status = await secondFactorStatus(db, context.accountId);
  if (!status.enabled) {
    return NextResponse.json({ error: "two_factor_disabled" }, { status: 409 });
  }
  const body = await readJsonBody(request);
  const denied = await requireWeakeningProof(db, context, body);
  if (denied) {
    return denied;
  }
  const codes = await regenerateRecoveryCodes(db, context.accountId);
  await recordAuditEvent(db, {
    accountId: context.accountId,
    actor: {
      accountId: context.accountId,
      providerSubject: context.providerSubject,
    },
    eventType: "account.recovery_codes_regenerated",
  });
  return NextResponse.json({ ok: true, recovery_codes: codes });
}

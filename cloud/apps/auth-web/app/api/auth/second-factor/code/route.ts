// Second step of sign-in with an authenticator code or a recovery code.
// Requires the pending-sign-in cookie minted by the password/Google step.
import { createDb } from "@frameos-cloud/db";
import { NextRequest, NextResponse } from "next/server";
import { recordAuditEvent } from "../../../../../src/lib/audit";
import { csrfResponse } from "../../../../../src/lib/csrf";
import { assertDatabaseUrlConfigured } from "../../../../../src/lib/env";
import {
  identityRateLimitResponse,
  rateLimitResponse,
} from "../../../../../src/lib/rate-limit";
import {
  completeSecondFactor,
  pendingSignInFromRequest,
  pendingSignInSpent,
  signedInResponse,
} from "../../../../../src/lib/sign-in";
import {
  secondFactorStatus,
  verifySecondFactorCode,
} from "../../../../../src/lib/two-factor";

export async function POST(request: NextRequest) {
  const csrf = csrfResponse(request);
  if (csrf) {
    return csrf;
  }
  const limited = await rateLimitResponse(request, "auth:second-factor", {
    limit: 30,
    windowMs: 15 * 60 * 1000,
  });
  if (limited) {
    return limited;
  }
  const pending = await pendingSignInFromRequest(request);
  if (!pending || (await pendingSignInSpent(pending))) {
    return NextResponse.json({ error: "sign_in_expired" }, { status: 401 });
  }
  const accountId = pending.profile.accountId;
  // Six digits are guessable at volume; the account-keyed limit is the one
  // that matters.
  const accountLimited = await identityRateLimitResponse(
    accountId,
    "auth:second-factor-account",
    { limit: 10, windowMs: 15 * 60 * 1000 },
  );
  if (accountLimited) {
    return accountLimited;
  }

  const body = (await request.json().catch(() => undefined)) as
    | { code?: unknown }
    | undefined;
  const code = typeof body?.code === "string" ? body.code.trim() : "";
  if (!code) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  assertDatabaseUrlConfigured();
  const db = createDb();
  const matched = await verifySecondFactorCode(db, accountId, code);
  if (!matched) {
    await recordAuditEvent(db, {
      accountId,
      actor: { accountId, providerSubject: pending.profile.providerSubject },
      eventType: "account.second_factor_failed",
      metadata: { method: "code" },
    });
    return NextResponse.json({ error: "invalid_code" }, { status: 401 });
  }

  const token = await completeSecondFactor(db, pending, matched);
  if (!token) {
    return NextResponse.json({ error: "sign_in_expired" }, { status: 401 });
  }
  const extra: Record<string, unknown> = {};
  if (matched === "recovery_code") {
    // Tell the UI how many are left so it can nudge a regeneration.
    const status = await secondFactorStatus(db, accountId);
    extra.recovery_codes_remaining = status.recoveryCodesRemaining;
  }
  return signedInResponse(token, pending.returnTo, extra);
}

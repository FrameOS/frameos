import { and, eq, isNull } from "drizzle-orm";
import {
  createDb,
  ensurePasswordIdentityForAccount,
  passwordResetTokens,
  revokeApiTokensForAccount,
  revokeSessionsForAccount,
  setAccountPassword,
} from "@frameos-cloud/db";
import { recordAuditEvent } from "../../../../../src/lib/audit";
import { NextRequest, NextResponse } from "next/server";
import { csrfResponse } from "../../../../../src/lib/csrf";
import { assertDatabaseUrlConfigured } from "../../../../../src/lib/env";
import {
  hashPassword,
  validatePasswordCandidate,
} from "../../../../../src/lib/passwords";
import { rateLimitResponse } from "../../../../../src/lib/rate-limit";
import { hashSecret } from "../../../../../src/lib/secrets";

export async function POST(request: NextRequest) {
  const csrf = csrfResponse(request);
  if (csrf) {
    return csrf;
  }

  const limited = await rateLimitResponse(request, "auth:reset-confirm", {
    limit: 10,
    windowMs: 15 * 60 * 1000,
  });
  if (limited) {
    return limited;
  }

  const body = (await request.json().catch(() => undefined)) as
    | { password?: unknown; token?: unknown }
    | undefined;
  const token = typeof body?.token === "string" ? body.token : "";
  const password = typeof body?.password === "string" ? body.password : "";
  if (!token || !password) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const passwordProblem = validatePasswordCandidate(password);
  if (passwordProblem) {
    return NextResponse.json(
      { error: "weak_password", message: passwordProblem },
      { status: 400 },
    );
  }

  assertDatabaseUrlConfigured();
  const db = createDb();

  // Atomic single-use claim: only one confirm call can flip used_at, so a
  // leaked or replayed link cannot reset the password twice.
  const [claimed] = await db
    .update(passwordResetTokens)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(passwordResetTokens.tokenHash, hashSecret(token)),
        isNull(passwordResetTokens.usedAt),
      ),
    )
    .returning({
      accountId: passwordResetTokens.accountId,
      expiresAt: passwordResetTokens.expiresAt,
    });

  if (!claimed || claimed.expiresAt <= new Date()) {
    return NextResponse.json({ error: "invalid_token" }, { status: 400 });
  }

  await setAccountPassword(db, claimed.accountId, await hashPassword(password));
  // Following the emailed link proves control of the address: it verifies an
  // existing password identity, or creates one (already verified) when a
  // Google-first account is adding its first password.
  await ensurePasswordIdentityForAccount(db, claimed.accountId);
  // A reset proves control of the email, not of existing sessions; sign
  // everything out so a session hijacker is evicted along the way — API
  // tokens included, since whoever forced the reset may have minted one.
  await revokeSessionsForAccount(db, claimed.accountId);
  await revokeApiTokensForAccount(db, claimed.accountId);

  await recordAuditEvent(db, {
    accountId: claimed.accountId,
    actor: { accountId: claimed.accountId },
    eventType: "account.password_reset",
  });

  return NextResponse.json({ ok: true });
}

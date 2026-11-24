import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import {
  accounts,
  createDb,
  revokeApiTokensForAccount,
  setAccountPassword,
} from "@frameos-cloud/db";
import {
  revokeOtherSessions,
  revokedTokensDetail,
} from "../../../../src/lib/account-security";
import { recordAuditEvent } from "../../../../src/lib/audit";
import { csrfResponse } from "../../../../src/lib/csrf";
import { sendSecurityNotificationEmail } from "../../../../src/lib/email";
import { assertDatabaseUrlConfigured } from "../../../../src/lib/env";
import { reportError } from "../../../../src/lib/log";
import {
  hashPassword,
  validatePasswordCandidate,
  verifyPasswordWithDummyFallback,
} from "../../../../src/lib/passwords";
import {
  identityRateLimitResponse,
  rateLimitResponse,
} from "../../../../src/lib/rate-limit";
import { requireRecentAuthWithSecondFactor } from "../../../../src/lib/recent-auth";
import { readSession } from "../../../../src/lib/session";

// Change the signed-in account's password. Requires the current password, so
// a hijacked session alone cannot lock the owner out; accounts without a
// password (Google-only) go through the email reset flow instead, which
// proves control of the address. On an account with two-factor the session
// must also have passed sudo mode (the second factor) recently: there the
// password alone proves less than sign-in did.
export async function POST(request: NextRequest) {
  const csrf = csrfResponse(request);
  if (csrf) {
    return csrf;
  }

  const session = await readSession();
  if (!session?.accountId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  // A bearer token is a script's credential, not the person's: with the
  // current password it could rotate the password and revoke every session
  // including the owner's — silently, since the bearer path has no cookie
  // to keep. Same rule as the other credential routes (delete, 2FA).
  if (session.apiToken) {
    return NextResponse.json(
      { error: "api_token_not_allowed" },
      { status: 403 },
    );
  }

  const limited =
    (await rateLimitResponse(request, "account:password-change", {
      limit: 10,
      windowMs: 15 * 60 * 1000,
    })) ??
    (await identityRateLimitResponse(session.accountId, "account:password-change", {
      limit: 10,
      windowMs: 15 * 60 * 1000,
    }));
  if (limited) {
    return limited;
  }

  const body = (await request.json().catch(() => undefined)) as
    | { currentPassword?: unknown; newPassword?: unknown }
    | undefined;
  const currentPassword =
    typeof body?.currentPassword === "string" ? body.currentPassword : "";
  const newPassword =
    typeof body?.newPassword === "string" ? body.newPassword : "";
  if (!currentPassword || !newPassword) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const passwordProblem = validatePasswordCandidate(newPassword);
  if (passwordProblem) {
    return NextResponse.json(
      { error: "weak_password", message: passwordProblem },
      { status: 400 },
    );
  }

  assertDatabaseUrlConfigured();
  const db = createDb();

  const [account] = await db
    .select({
      passwordHash: accounts.passwordHash,
      primaryEmail: accounts.primaryEmail,
    })
    .from(accounts)
    .where(eq(accounts.id, session.accountId))
    .limit(1);
  if (!account) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const reauth = await requireRecentAuthWithSecondFactor(db, session.accountId);
  if (reauth) {
    return reauth;
  }

  const currentPasswordValid = await verifyPasswordWithDummyFallback(
    currentPassword,
    account.passwordHash,
  );
  if (!account.passwordHash) {
    return NextResponse.json({ error: "no_password" }, { status: 400 });
  }
  if (!currentPasswordValid) {
    return NextResponse.json({ error: "invalid_password" }, { status: 400 });
  }

  await setAccountPassword(
    db,
    session.accountId,
    await hashPassword(newPassword),
  );

  // Changing the password evicts every other session (a stolen session is a
  // likely reason to change it), but keeps this one signed in.
  await revokeOtherSessions(db, session.accountId);
  // The personal API tokens go too, as on a password reset and a second-
  // factor change: whoever had the account long enough to mint one would
  // otherwise keep a script-shaped way in that outlives the new password.
  const apiTokensRevoked = await revokeApiTokensForAccount(
    db,
    session.accountId,
  );

  await recordAuditEvent(db, {
    accountId: session.accountId,
    actor: { accountId: session.accountId },
    eventType: "account.password_changed",
    metadata: { apiTokensRevoked },
  });

  // The one credential change that had no mail: whoever holds the address
  // learns their password was rotated (and every other session signed out)
  // even when it was not them doing it. Best-effort, like the 2FA mails.
  if (account.primaryEmail) {
    try {
      await sendSecurityNotificationEmail(account.primaryEmail, {
        detail: revokedTokensDetail(apiTokensRevoked, "password"),
        what: "password_changed",
        when: new Date(),
      });
    } catch (error) {
      reportError("account.password_changed_mail_failed", error);
    }
  }

  return NextResponse.json({ api_tokens_revoked: apiTokensRevoked, ok: true });
}

// Connects a Google or Apple identity to the existing account that has its
// email, once the visitor proves that account. Two proofs:
//
// - {"password": "..."}: the account's password. The second factor, if the
//   account has one, is asked next, as after a password sign-in.
// - {} with a session cookie for that very account that proved its
//   credentials within recentAuthMaxAgeSeconds: the visitor has just signed
//   in to it another way (Google, a passkey, Apple, or the password on the
//   sign-in page). That session already passed the second factor.
//
// The web's /login/link posts here, and so does the iOS app after a native
// Sign in with Apple that matched an account: with the password, or after
// signing in to the account through the web's sign-in sheet.
//
// The provider half of the proof is the pending-link cookie the callback set
// (src/lib/provider-link.ts): verified claims, ten minutes old at most. Only
// with both halves does the identity get written: a provider attesting an
// email address is not the same as holding the account behind it.
//
// Linking is a credential change on the account, so it gets the same
// treatment as a password reset: every existing session is revoked (the
// visitor gets a fresh one below), the owner is emailed, and an audit row is
// written. API tokens stay: they are the account's, not a sign-in method.
import { eq } from "drizzle-orm";
import {
  accounts,
  createDb,
  findIdentity,
  linkIdentityToAccount,
  revokeSessionsForAccount,
  setIdentityProviderToken,
} from "@frameos-cloud/db";
import { NextRequest, NextResponse } from "next/server";
import { recordAuditEvent } from "../../../../src/lib/audit";
import { csrfResponse } from "../../../../src/lib/csrf";
import { sendSecurityNotificationEmail } from "../../../../src/lib/email";
import { assertDatabaseUrlConfigured } from "../../../../src/lib/env";
import {
  linkConfirmMethods,
  pendingLinkCookieName,
  pendingLinkCookieOptions,
  readPendingLinkToken,
} from "../../../../src/lib/provider-link";
import { reportError } from "../../../../src/lib/log";
import { verifyPasswordWithDummyFallback } from "../../../../src/lib/passwords";
import {
  identityRateLimitResponse,
  rateLimitResponse,
} from "../../../../src/lib/rate-limit";
import {
  isRecent,
  liveSessionByToken,
  reauthPath,
  recentAuthMaxAgeSeconds,
} from "../../../../src/lib/recent-auth";
import {
  sessionCookieName,
  sessionCookieOptions,
} from "../../../../src/lib/session";
import {
  completeFirstFactor,
  continueProvenSignIn,
} from "../../../../src/lib/sign-in";
import { defaultSignInRedirect } from "../../../../src/lib/sign-in-redirect";
import {
  pendingSignInCookieName,
  pendingSignInCookieOptions,
} from "../../../../src/lib/two-factor";

export const runtime = "nodejs";

function clearPendingCookie(response: NextResponse) {
  response.cookies.set(pendingLinkCookieName, "", {
    ...pendingLinkCookieOptions(),
    maxAge: 0,
  });
  return response;
}

export async function POST(request: NextRequest) {
  const csrf = csrfResponse(request);
  if (csrf) {
    return csrf;
  }
  // Same budget as the password login: this IS a password check.
  const limited = await rateLimitResponse(request, "auth:link", {
    limit: 20,
    windowMs: 15 * 60 * 1000,
  });
  if (limited) {
    return limited;
  }

  const pending = await readPendingLinkToken(
    request.cookies.get(pendingLinkCookieName)?.value,
  );
  if (!pending) {
    return NextResponse.json({ error: "link_expired" }, { status: 400 });
  }

  const body = (await request.json().catch(() => undefined)) as
    | { password?: unknown }
    | undefined;
  const password = typeof body?.password === "string" ? body.password : "";

  // Keyed on the target account, so guessing one account's password across
  // many addresses is bounded the way /api/auth/login bounds it by email.
  const accountLimited = await identityRateLimitResponse(
    pending.accountId,
    "auth:link-account",
    { limit: 20, windowMs: 15 * 60 * 1000 },
  );
  if (accountLimited) {
    return accountLimited;
  }

  assertDatabaseUrlConfigured();
  const db = createDb();
  const [account] = await db
    .select({
      displayName: accounts.displayName,
      passwordHash: accounts.passwordHash,
      primaryEmail: accounts.primaryEmail,
    })
    .from(accounts)
    .where(eq(accounts.id, pending.accountId))
    .limit(1);

  // The proof. A password is checked here; otherwise the request's session
  // must be this account's, and recent.
  let provenAt: Date | undefined;
  if (password) {
    const valid = await verifyPasswordWithDummyFallback(
      password,
      account?.passwordHash,
    );
    if (!account || !valid) {
      await recordAuditEvent(db, {
        accountId: pending.accountId,
        actor: { kind: `${pending.providerKey}_link`, providerSubject: pending.providerSubject },
        eventType: `account.${pending.providerKey}_link_failed`,
        metadata: { email: pending.email },
      });
      return NextResponse.json({ error: "invalid_password" }, { status: 403 });
    }
  } else {
    const session = await liveSessionByToken(
      db,
      request.cookies.get(sessionCookieName)?.value,
    );
    if (!account || !session) {
      // Nothing proves the account yet: the client offers these.
      return NextResponse.json(
        {
          error: "confirm_required",
          methods: await linkConfirmMethods(db, pending.accountId, pending.providerKey),
        },
        { status: 400 },
      );
    }
    if (session.accountId !== pending.accountId) {
      return NextResponse.json({ error: "wrong_account" }, { status: 409 });
    }
    if (!isRecent(session.authenticatedAt)) {
      return NextResponse.json(
        {
          error: "reauth_required",
          reauth: { max_age_seconds: recentAuthMaxAgeSeconds, path: reauthPath },
        },
        { status: 403 },
      );
    }
    provenAt = session.authenticatedAt;
  }

  // The cookie is ten minutes old at most, but the identity may have
  // been linked elsewhere in the meantime (a second tab, another account).
  // The identities table has one row per (issuer, subject); refuse rather
  // than throw on the unique index.
  const existing = await findIdentity(
    db,
    pending.providerIssuer,
    pending.providerSubject,
  );
  if (existing && existing.accountId !== pending.accountId) {
    return clearPendingCookie(
      NextResponse.json({ error: "link_conflict" }, { status: 409 }),
    );
  }
  if (!existing) {
    await linkIdentityToAccount(db, {
      accountId: pending.accountId,
      email: pending.email,
      emailVerified: true,
      providerIssuer: pending.providerIssuer,
      providerKey: pending.providerKey,
      providerSubject: pending.providerSubject,
    });
  }
  if (pending.providerToken) {
    await setIdentityProviderToken(
      db,
      pending.providerIssuer,
      pending.providerSubject,
      pending.providerToken,
    );
  }

  // A new way into the account: every session that predates it goes,
  // including the one that proved it. The fresh session minted below is the
  // only one left.
  await revokeSessionsForAccount(db, pending.accountId);

  await recordAuditEvent(db, {
    accountId: pending.accountId,
    actor: { accountId: pending.accountId, providerSubject: pending.providerSubject },
    eventType: `account.${pending.providerKey}_linked`,
    metadata: { email: pending.email, proof: provenAt ? "session" : "password" },
    target: { providerIssuer: pending.providerIssuer },
  });

  // Same address on both sides, so one mail. Never fails the link: the
  // identity is already written.
  try {
    await sendSecurityNotificationEmail(account?.primaryEmail ?? pending.email, {
      detail: pending.email,
      what: `${pending.providerKey}_linked`,
      when: new Date(),
    });
  } catch (error) {
    reportError("email.security_notification_send_failed", error, {
      accountId: pending.accountId,
      what: `${pending.providerKey}_linked`,
    });
  }

  const profile = {
    accountId: pending.accountId,
    email: pending.email,
    emailVerified: true,
    name: pending.name ?? account?.displayName ?? undefined,
    providerIssuer: pending.providerIssuer,
    providerSubject: pending.providerSubject,
  };
  const auditMetadata = { email: pending.email, emailVerified: true, linked: true };

  if (provenAt) {
    const token = await continueProvenSignIn(db, {
      auditMetadata,
      authenticatedAt: provenAt,
      method: pending.providerKey,
      profile,
    });
    const response = NextResponse.json({
      ok: true,
      redirect: pending.returnTo ?? defaultSignInRedirect,
    });
    response.cookies.set(sessionCookieName, token, sessionCookieOptions());
    return clearPendingCookie(response);
  }

  const outcome = await completeFirstFactor(db, {
    auditMetadata,
    method: pending.providerKey,
    profile,
    returnTo: pending.returnTo,
  });

  if (outcome.kind === "second_factor") {
    const response = NextResponse.json({
      ok: true,
      redirect: "/login/verify",
      second_factor_required: true,
    });
    response.cookies.set(
      pendingSignInCookieName,
      outcome.pendingToken,
      pendingSignInCookieOptions(),
    );
    return clearPendingCookie(response);
  }

  const response = NextResponse.json({
    ok: true,
    redirect: pending.returnTo ?? defaultSignInRedirect,
  });
  response.cookies.set(sessionCookieName, outcome.token, sessionCookieOptions());
  return clearPendingCookie(response);
}

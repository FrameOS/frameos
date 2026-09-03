// Connects a Google identity to an existing password account, once the
// visitor proves the account's password. Body: {"password": "..."}.
//
// The Google half of the proof is the pending-link cookie the callback set
// (src/lib/google-link.ts): verified claims, ten minutes old at most. The
// password half is checked here. Only with both does the identity get
// written — Google attesting an email address is not the same as holding
// the account behind it.
//
// Linking is a credential change on the account, so it gets the same
// treatment as a password reset: every existing session is revoked (the
// visitor gets a fresh one below), the owner is emailed, and an audit row is
// written. API tokens stay — they are the account's, not a sign-in method.
import { eq } from "drizzle-orm";
import {
  accounts,
  createDb,
  findIdentity,
  googleProviderKey,
  linkIdentityToAccount,
  revokeSessionsForAccount,
} from "@frameos-cloud/db";
import { NextRequest, NextResponse } from "next/server";
import { recordAuditEvent } from "../../../../../src/lib/audit";
import { csrfResponse } from "../../../../../src/lib/csrf";
import { sendSecurityNotificationEmail } from "../../../../../src/lib/email";
import { assertDatabaseUrlConfigured } from "../../../../../src/lib/env";
import {
  pendingGoogleLinkCookieName,
  pendingGoogleLinkCookieOptions,
  readPendingGoogleLinkToken,
} from "../../../../../src/lib/google-link";
import { reportError } from "../../../../../src/lib/log";
import { verifyPasswordWithDummyFallback } from "../../../../../src/lib/passwords";
import {
  identityRateLimitResponse,
  rateLimitResponse,
} from "../../../../../src/lib/rate-limit";
import {
  sessionCookieName,
  sessionCookieOptions,
} from "../../../../../src/lib/session";
import { completeFirstFactor } from "../../../../../src/lib/sign-in";
import { defaultSignInRedirect } from "../../../../../src/lib/sign-in-redirect";
import {
  pendingSignInCookieName,
  pendingSignInCookieOptions,
} from "../../../../../src/lib/two-factor";

export const runtime = "nodejs";

function clearPendingCookie(response: NextResponse) {
  response.cookies.set(pendingGoogleLinkCookieName, "", {
    ...pendingGoogleLinkCookieOptions(),
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
  const limited = await rateLimitResponse(request, "auth:google-link", {
    limit: 20,
    windowMs: 15 * 60 * 1000,
  });
  if (limited) {
    return limited;
  }

  const pending = await readPendingGoogleLinkToken(
    request.cookies.get(pendingGoogleLinkCookieName)?.value,
  );
  if (!pending) {
    return NextResponse.json({ error: "link_expired" }, { status: 400 });
  }

  const body = (await request.json().catch(() => undefined)) as
    | { password?: unknown }
    | undefined;
  const password = typeof body?.password === "string" ? body.password : "";
  if (!password) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  // Keyed on the target account, so guessing one account's password across
  // many addresses is bounded the way /api/auth/login bounds it by email.
  const accountLimited = await identityRateLimitResponse(
    pending.accountId,
    "auth:google-link-account",
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
  const valid = await verifyPasswordWithDummyFallback(
    password,
    account?.passwordHash,
  );
  if (!account || !valid) {
    await recordAuditEvent(db, {
      accountId: pending.accountId,
      actor: { kind: "google_link", providerSubject: pending.providerSubject },
      eventType: "account.google_link_failed",
      metadata: { email: pending.email },
    });
    return NextResponse.json({ error: "invalid_password" }, { status: 403 });
  }

  // The cookie is ten minutes old at most, but the Google identity may have
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
      providerKey: googleProviderKey,
      providerSubject: pending.providerSubject,
    });
  }

  // A new way into the account: every session that predates it goes. The
  // fresh session minted below is the only one left.
  await revokeSessionsForAccount(db, pending.accountId);

  await recordAuditEvent(db, {
    accountId: pending.accountId,
    actor: { accountId: pending.accountId, providerSubject: pending.providerSubject },
    eventType: "account.google_linked",
    metadata: { email: pending.email },
    target: { providerIssuer: pending.providerIssuer },
  });

  // Same address on both sides, so one mail. Never fails the link: the
  // identity is already written.
  try {
    await sendSecurityNotificationEmail(account.primaryEmail ?? pending.email, {
      detail: pending.email,
      what: "google_linked",
      when: new Date(),
    });
  } catch (error) {
    reportError("email.security_notification_send_failed", error, {
      accountId: pending.accountId,
      what: "google_linked",
    });
  }

  const outcome = await completeFirstFactor(db, {
    auditMetadata: { email: pending.email, emailVerified: true, linked: true },
    method: "google",
    profile: {
      accountId: pending.accountId,
      email: pending.email,
      emailVerified: true,
      name: pending.name ?? account.displayName ?? undefined,
      providerIssuer: pending.providerIssuer,
      providerSubject: pending.providerSubject,
    },
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

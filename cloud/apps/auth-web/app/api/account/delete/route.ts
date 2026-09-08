import { eq } from "drizzle-orm";
import { accounts, createDb, normalizeEmail } from "@frameos-cloud/db";
import { closeOutSubscriptionForDeletedAccount } from "@frameos-cloud/ledger";
import { NextRequest, NextResponse } from "next/server";
import { recordAuditEvent } from "../../../../src/lib/audit";
import { csrfResponse } from "../../../../src/lib/csrf";
import { assertDatabaseUrlConfigured } from "../../../../src/lib/env";
import { verifyPasswordWithDummyFallback } from "../../../../src/lib/passwords";
import {
  identityRateLimitResponse,
  rateLimitResponse,
} from "../../../../src/lib/rate-limit";
import { requireRecentAuth } from "../../../../src/lib/recent-auth";
import {
  readSession,
  sessionCookieName,
  sessionCookieOptions,
} from "../../../../src/lib/session";

// Self-serve account deletion (GDPR art. 17). Until this existed, erasure
// meant emailing a superadmin and waiting — which is a right on paper only.
//
// Re-authentication is required: deletion is the most destructive thing an
// account can do, and a session alone should not be enough to do it from a
// borrowed laptop. Accounts with a password confirm with it. Accounts without
// one (Google-only, passkey-only) go through the same sudo-mode gate the
// other destructive routes use (requireRecentAuth → /login/reauth, which
// offers Google with prompt=login, a passkey or a code — whatever the account
// has); typing the email address is then the deliberate-action check on top,
// not the proof of identity it was asked to be before.
//
// The delete itself is a single row: every table that holds this account's
// data cascades from accounts.id (see packages/db/src/schema.ts). Two
// exceptions. audit_events is ON DELETE SET NULL, so the security trail
// survives with the account identifier stripped out — a security log that
// the subject can erase is not a security log; a de-identified one is not
// their personal data either. The privacy policy says so out loud. And the
// accounting tables reference nothing (cloud/docs/accounting-todo.md §2.1):
// the books keep a bare uuid, and a subscription in progress is closed out
// BELOW before the row goes, so its unearned remainder returns to the
// receivable rather than sitting as deferred revenue nothing will ever earn.

export async function POST(request: NextRequest) {
  const csrf = csrfResponse(request);
  if (csrf) {
    return csrf;
  }

  const session = await readSession();
  const accountId = session?.accountId;
  if (!accountId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  // Erasure is proved with the password, or for password-less accounts with
  // the primary email — which any token can read. A bearer token is a
  // script's credential, not the person's; it does not get to end the account.
  if (session.apiToken) {
    return NextResponse.json(
      { error: "api_token_not_allowed" },
      { status: 403 },
    );
  }

  const limited =
    (await rateLimitResponse(request, "account:delete", {
      limit: 10,
      windowMs: 60 * 60 * 1000,
    })) ??
    (await identityRateLimitResponse(accountId, "account:delete", {
      limit: 10,
      windowMs: 60 * 60 * 1000,
    }));
  if (limited) {
    return limited;
  }

  const body = (await request.json().catch(() => undefined)) as
    | { confirmEmail?: unknown; password?: unknown }
    | undefined;
  const password = typeof body?.password === "string" ? body.password : "";
  const confirmEmail =
    typeof body?.confirmEmail === "string" ? body.confirmEmail : "";

  assertDatabaseUrlConfigured();
  const db = createDb();

  const [account] = await db
    .select({
      isSuperadmin: accounts.isSuperadmin,
      passwordHash: accounts.passwordHash,
      primaryEmail: accounts.primaryEmail,
    })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  if (!account) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Same lockout-prevention rule as the admin panel's delete: the last way
  // into /admin must not be removable by accident from a settings page.
  // Superadmins hand the flag over (or have another superadmin do it) first.
  if (account.isSuperadmin) {
    return NextResponse.json(
      { error: "superadmin_cannot_self_delete" },
      { status: 400 },
    );
  }

  if (account.passwordHash) {
    // Dummy fallback keeps the timing flat whether or not a hash exists.
    const valid = await verifyPasswordWithDummyFallback(
      password,
      account.passwordHash,
    );
    if (!valid) {
      return NextResponse.json({ error: "invalid_password" }, { status: 400 });
    }
  } else {
    // No password to prove with: the session itself has to have proved its
    // credentials recently. The Security page prints the email, so on its
    // own it proves nothing.
    const reauth = await requireRecentAuth(db, accountId);
    if (reauth) {
      return reauth;
    }
    if (
      !account.primaryEmail ||
      normalizeEmail(confirmEmail) !== normalizeEmail(account.primaryEmail)
    ) {
      return NextResponse.json({ error: "invalid_confirmation" }, { status: 400 });
    }
  }

  // Recorded BEFORE the delete: recordAuditEvent writes account_id, and after
  // the row is gone the foreign key would reject it. The event survives the
  // cascade because audit_events.account_id is SET NULL, not CASCADE.
  await recordAuditEvent(db, {
    accountId,
    actor: { accountId },
    eventType: "account.self_deleted",
    metadata: { email: account.primaryEmail },
  });

  // Books first: return the unearned rest of any subscription period to the
  // receivable and end the subscription. The receivable that remains is a
  // write-off decision for a human, not something erasure may silently drop.
  await closeOutSubscriptionForDeletedAccount(db, accountId);

  await db.delete(accounts).where(eq(accounts.id, accountId));

  const response = NextResponse.json({ ok: true });
  response.cookies.set(sessionCookieName, "", {
    ...sessionCookieOptions(),
    expires: new Date(0),
    maxAge: 0,
  });
  response.headers.set("Cache-Control", "no-store, max-age=0");
  return response;
}

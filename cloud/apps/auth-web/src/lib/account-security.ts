// Shared plumbing for the /api/account/two-factor/* routes: the signed-in
// account, and the "prove it's you" check in front of anything that weakens
// the account (removing an authenticator or passkey, turning 2FA off).
//
// A session alone is a cookie on a shared laptop; removing a second factor
// with it would make the factor pointless. So those routes re-ask for the
// password when the account has one, or for a current authenticator /
// recovery code otherwise. Passkey-only accounts without a password are the
// one case that falls back to the session: there is nothing else to ask for,
// and a passkey assertion already required user verification to get here.

import { eq } from "drizzle-orm";
import { accounts, type createDb } from "@frameos-cloud/db";
import { NextRequest, NextResponse } from "next/server";
import { csrfResponse } from "./csrf";
import { verifyPasswordWithDummyFallback } from "./passwords";
import { identityRateLimitResponse, rateLimitResponse } from "./rate-limit";
import { readSession } from "./session";
import { secondFactorStatus, verifySecondFactorCode } from "./two-factor";

export type AccountSessionContext = {
  accountId: string;
  displayName?: string | undefined;
  email: string;
  hasPassword: boolean;
  providerSubject: string;
};

// Session + account row, or the response to send instead. `mutating` adds
// the CSRF origin check and a per-account limit so a stolen session cannot
// hammer the code/password checks.
export async function accountSecurityContext(
  request: NextRequest,
  db: ReturnType<typeof createDb>,
  options: { action: string; limit?: number; mutating?: boolean } = {
    action: "two-factor",
  },
): Promise<AccountSessionContext | { response: NextResponse }> {
  if (options.mutating) {
    const csrf = csrfResponse(request);
    if (csrf) {
      return { response: csrf };
    }
  }
  const limited = await rateLimitResponse(
    request,
    `account:${options.action}`,
    { limit: options.limit ?? 60, windowMs: 15 * 60 * 1000 },
  );
  if (limited) {
    return { response: limited };
  }
  const session = await readSession();
  if (!session?.accountId) {
    return {
      response: NextResponse.json({ error: "login_required" }, { status: 401 }),
    };
  }
  if (options.mutating) {
    const accountLimited = await identityRateLimitResponse(
      session.accountId,
      `account:${options.action}`,
      { limit: options.limit ?? 30, windowMs: 15 * 60 * 1000 },
    );
    if (accountLimited) {
      return { response: accountLimited };
    }
  }
  const [account] = await db
    .select({
      displayName: accounts.displayName,
      passwordHash: accounts.passwordHash,
      primaryEmail: accounts.primaryEmail,
    })
    .from(accounts)
    .where(eq(accounts.id, session.accountId))
    .limit(1);
  if (!account) {
    return {
      response: NextResponse.json({ error: "login_required" }, { status: 401 }),
    };
  }
  return {
    accountId: session.accountId,
    displayName: account.displayName ?? undefined,
    email: session.email ?? account.primaryEmail ?? session.providerSubject,
    hasPassword: Boolean(account.passwordHash),
    providerSubject: session.providerSubject,
  };
}

// Verifies the proof a weakening action carries in its body. Returns the
// error response to send, or undefined when the caller may proceed.
export async function requireWeakeningProof(
  db: ReturnType<typeof createDb>,
  context: AccountSessionContext,
  body: Record<string, unknown> | undefined,
): Promise<NextResponse | undefined> {
  if (context.hasPassword) {
    const [account] = await db
      .select({ passwordHash: accounts.passwordHash })
      .from(accounts)
      .where(eq(accounts.id, context.accountId))
      .limit(1);
    const password = typeof body?.password === "string" ? body.password : "";
    const valid = await verifyPasswordWithDummyFallback(
      password,
      account?.passwordHash,
    );
    if (!valid) {
      return NextResponse.json({ error: "invalid_password" }, { status: 403 });
    }
    return undefined;
  }
  const status = await secondFactorStatus(db, context.accountId);
  if (status.totpEnabled || status.recoveryCodesRemaining > 0) {
    const matched = await verifySecondFactorCode(
      db,
      context.accountId,
      body?.code,
    );
    if (!matched) {
      return NextResponse.json({ error: "invalid_code" }, { status: 403 });
    }
  }
  return undefined;
}

export async function readJsonBody(request: NextRequest) {
  const body = (await request.json().catch(() => undefined)) as unknown;
  return body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : undefined;
}

// The Security page / GET status payload (snake_case, ISO dates).
export async function twoFactorStatusPayload(
  db: ReturnType<typeof createDb>,
  accountId: string,
  hasPassword: boolean,
) {
  const status = await secondFactorStatus(db, accountId);
  return {
    enabled: status.enabled,
    has_password: hasPassword,
    passkeys: status.passkeys.map((passkey) => ({
      backed_up: passkey.backedUp,
      created_at: passkey.createdAt.toISOString(),
      id: passkey.id,
      last_used_at: passkey.lastUsedAt?.toISOString() ?? null,
      name: passkey.name,
    })),
    recovery_codes_remaining: status.recoveryCodesRemaining,
    totp_enabled: status.totpEnabled,
    totp_pending: status.totpPending,
  };
}

// Re-authentication ("sudo mode") for sensitive actions.
//
// A session cookie is a laptop left open; revoking a frame or approving a
// device grant with one should cost a second look at the credentials. Every
// session row remembers when it last proved them (`authenticated_at`: set at
// sign-in, pushed forward by /api/auth/reauth), and the routes listed in
// cloud/docs/auth.md "Re-authentication" refuse with 403 `reauth_required`
// when that is older than `recentAuthMaxAgeSeconds`. The browser then sends
// the user to /login/reauth, which asks for the password, an authenticator /
// recovery code, or a passkey — whichever the account has — and comes back.
//
// This is on purpose a second check on top of readSession(), not folded into
// it: the freshness is a property of the session row, most routes never need
// it, and the proof routes must be able to address the row by its token.

import { and, eq, gt, isNull } from "drizzle-orm";
import { accounts, type createDb, sessions } from "@frameos-cloud/db";
import { NextResponse } from "next/server";
import { readSessionToken } from "./session";
import { hashSecret } from "./secrets";
import { secondFactorStatus } from "./two-factor";

// Fifteen minutes: long enough to revoke a handful of frames or approve a
// scope change without re-proving between each, short enough that a cookie
// picked up from an unattended session cannot do it hours later.
export const recentAuthMaxAgeSeconds = 15 * 60;

export const reauthPath = "/login/reauth";

// Which proofs /login/reauth can ask this account for. `password` when the
// account has one; `code` when an authenticator is confirmed or recovery
// codes remain; `passkey` when one is registered. An account with none of
// them (Google-only, no second factor) can only sign in again through Google,
// which mints a fresh session (`sign_in`).
export type ReauthMethods = {
  code: boolean;
  passkey: boolean;
  password: boolean;
  sign_in: boolean;
};

export async function reauthMethods(
  db: ReturnType<typeof createDb>,
  accountId: string,
): Promise<ReauthMethods> {
  const [account] = await db
    .select({ passwordHash: accounts.passwordHash })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  const status = await secondFactorStatus(db, accountId);
  const password = Boolean(account?.passwordHash);
  const code = status.totpEnabled || status.recoveryCodesRemaining > 0;
  const passkey = status.passkeys.length > 0;
  return { code, passkey, password, sign_in: !password && !code && !passkey };
}

// When the current request's session last proved its credentials, or
// undefined when there is no live session.
export async function sessionAuthenticatedAt(
  db: ReturnType<typeof createDb>,
  token: string | undefined,
) {
  if (!token) {
    return undefined;
  }
  const [row] = await db
    .select({ authenticatedAt: sessions.authenticatedAt })
    .from(sessions)
    .where(
      and(eq(sessions.tokenHash, hashSecret(token)), isNull(sessions.revokedAt)),
    )
    .limit(1);
  return row?.authenticatedAt;
}

export function isRecent(authenticatedAt: Date | undefined, now = new Date()) {
  return (
    authenticatedAt !== undefined &&
    now.getTime() - authenticatedAt.getTime() <= recentAuthMaxAgeSeconds * 1000
  );
}

// True when the request's session proved its credentials recently enough for
// a sensitive action. Pages use it to send the user through /login/reauth
// before showing an approve button they could not press.
export async function hasRecentAuth(db: ReturnType<typeof createDb>) {
  return isRecent(await sessionAuthenticatedAt(db, await readSessionToken()));
}

// The response a sensitive route sends instead of acting, or undefined when
// the session is fresh enough. Call after readSession() has established the
// account; the payload tells the client which proofs /login/reauth offers.
export async function requireRecentAuth(
  db: ReturnType<typeof createDb>,
  accountId: string,
): Promise<NextResponse | undefined> {
  if (await hasRecentAuth(db)) {
    return undefined;
  }
  return NextResponse.json(
    {
      error: "reauth_required",
      reauth: {
        max_age_seconds: recentAuthMaxAgeSeconds,
        methods: await reauthMethods(db, accountId),
        path: reauthPath,
      },
    },
    { status: 403 },
  );
}

// The proof routes call this once the credentials checked out: stamps the
// session row so the next sensitive request goes through. Returns false when
// the token no longer names a live session (nothing to stamp).
export async function markSessionReauthenticated(
  db: ReturnType<typeof createDb>,
  token: string,
  now = new Date(),
) {
  const rows = await db
    .update(sessions)
    .set({ authenticatedAt: now })
    .where(
      and(
        eq(sessions.tokenHash, hashSecret(token)),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, now),
      ),
    )
    .returning({ id: sessions.id });
  return rows.length > 0;
}

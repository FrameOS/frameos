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
import {
  accountSocialProviders,
  accounts,
  type createDb,
  sessions,
  type SocialProviderKey,
} from "@frameos-cloud/db";
import { NextResponse } from "next/server";
import { readSessionToken } from "./session";
import { hashSecret } from "./secrets";
import { secondFactorStatus } from "./two-factor";

// Two windows, matched to what the action can do. Revoking is destructive
// and rare — fifteen minutes: long enough to revoke a handful of frames
// without re-proving between each, short enough that a cookie picked up from
// an unattended session cannot do it hours later. Approving a device link is
// additive and happens in batches ("I'm setting up frames this afternoon") —
// two hours, the same order GitHub's sudo mode uses; the gate still matters
// because an approval converts a transient stolen cookie into a durable
// token, but a fresh-that-afternoon login is proof enough for it.
export const recentAuthMaxAgeSeconds = 15 * 60;
export const recentApprovalMaxAgeSeconds = 2 * 60 * 60;

export const reauthPath = "/login/reauth";

// How long a sign-in lets the in-browser preview read every saved service key
// (GET /api/settings?reveal=1), the owner's pick on the Security page
// (`accounts.saved_keys_reauth_seconds`). The default is the approval window;
// the longer ones are for an owner who would rather not be asked while
// building scenes. 0 = for as long as the session lasts (its own idle and
// absolute deadlines still end it). Making it looser takes a recent
// confirmation itself, or a lifted cookie could turn the gate off.
export const savedKeysReauthChoices = [
  recentApprovalMaxAgeSeconds,
  24 * 60 * 60,
  7 * 24 * 60 * 60,
  0,
] as const;

export function isSavedKeysReauthChoice(value: unknown): value is number {
  return (
    typeof value === "number" &&
    (savedKeysReauthChoices as readonly number[]).includes(value)
  );
}

// The account's window in seconds; null when the reveal is never gated.
export function savedKeysRevealMaxAge(
  stored: number | null | undefined,
): number | null {
  if (stored === 0) {
    return null;
  }
  return isSavedKeysReauthChoice(stored) ? stored : recentApprovalMaxAgeSeconds;
}

// Whether `next` asks less often than `current`: a longer window, or none.
export function savedKeysReauthIsLooser(
  current: number | null | undefined,
  next: number,
): boolean {
  const before = savedKeysRevealMaxAge(current);
  const after = savedKeysRevealMaxAge(next);
  if (before === null) {
    return false;
  }
  return after === null || after > before;
}

// Which proofs /login/reauth can ask this account for. `code` when an
// authenticator is confirmed or recovery codes remain; `passkey` when one is
// registered; `password` when the account has one AND no second factor —
// once two-factor is on, sudo mode asks for the second factor, the same
// thing sign-in asks for, so a password alone (the one credential a phished
// or reused secret gives an attacker) can no longer revoke frames, mint
// tokens or turn two-factor itself off. An account with none of them
// (Google or Apple only, no second factor) can only sign in again through
// its provider, which mints a fresh session (`sign_in`); `providers` says
// which ones the account has.
export type ReauthMethods = {
  code: boolean;
  passkey: boolean;
  password: boolean;
  providers: SocialProviderKey[];
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
  const code = status.totpEnabled || status.recoveryCodesRemaining > 0;
  const passkey = status.passkeys.length > 0;
  const password = Boolean(account?.passwordHash) && !secondFactorEnrolled(status);
  const sign_in = !password && !code && !passkey;
  const providers = sign_in ? await accountSocialProviders(db, accountId) : [];
  return { code, passkey, password, providers, sign_in };
}

// Two-factor is ON exactly when a confirmed authenticator or a passkey
// exists (docs/auth.md: the credentials are the flag). Recovery codes alone
// do not count — they outlive the factor they backed only until the last
// one is removed, and an account with only codes left is not protected by
// them.
export function secondFactorEnrolled(status: {
  passkeys: unknown[];
  totpEnabled: boolean;
}) {
  return status.totpEnabled || status.passkeys.length > 0;
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

// The live session a session token names (not revoked, inside both its idle
// and absolute deadlines): whose it is and when it last proved the
// credentials. For a route that takes a recent session of one particular
// account as proof (POST /api/auth/link) and reads the cookie off its
// request.
export async function liveSessionByToken(
  db: ReturnType<typeof createDb>,
  token: string | undefined,
  now = new Date(),
) {
  if (!token) {
    return undefined;
  }
  const [row] = await db
    .select({
      accountId: sessions.accountId,
      authenticatedAt: sessions.authenticatedAt,
    })
    .from(sessions)
    .where(
      and(
        eq(sessions.tokenHash, hashSecret(token)),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, now),
        gt(sessions.absoluteExpiresAt, now),
      ),
    )
    .limit(1);
  return row;
}

export function isRecent(
  authenticatedAt: Date | undefined,
  maxAgeSeconds: number = recentAuthMaxAgeSeconds,
  now = new Date(),
) {
  return (
    authenticatedAt !== undefined &&
    now.getTime() - authenticatedAt.getTime() <= maxAgeSeconds * 1000
  );
}

// True when the request's session proved its credentials recently enough for
// a sensitive action. Pages use it to send the user through /login/reauth
// before showing an approve button they could not press.
export async function hasRecentAuth(
  db: ReturnType<typeof createDb>,
  maxAgeSeconds: number = recentAuthMaxAgeSeconds,
) {
  return isRecent(
    await sessionAuthenticatedAt(db, await readSessionToken()),
    maxAgeSeconds,
  );
}

// The response a sensitive route sends instead of acting, or undefined when
// the session is fresh enough. Call after readSession() has established the
// account; the payload tells the client which proofs /login/reauth offers.
export async function requireRecentAuth(
  db: ReturnType<typeof createDb>,
  accountId: string,
  maxAgeSeconds: number = recentAuthMaxAgeSeconds,
): Promise<NextResponse | undefined> {
  if (await hasRecentAuth(db, maxAgeSeconds)) {
    return undefined;
  }
  return NextResponse.json(
    {
      error: "reauth_required",
      reauth: {
        max_age_seconds: maxAgeSeconds,
        methods: await reauthMethods(db, accountId),
        path: reauthPath,
      },
    },
    { status: 403 },
  );
}

// For a route that already takes the password in its body (changing it,
// deleting the account). Without two-factor that password is exactly what
// /login/reauth would ask for, so asking twice proves nothing more. With
// two-factor on, the password is the one credential that proves LESS than
// sign-in did: the session must also have passed sudo mode recently, which
// on such an account is the second factor. So the password alone, typed into
// a lifted cookie's session, never weakens an account that has one.
export async function requireRecentAuthWithSecondFactor(
  db: ReturnType<typeof createDb>,
  accountId: string,
  maxAgeSeconds: number = recentAuthMaxAgeSeconds,
): Promise<NextResponse | undefined> {
  if (!secondFactorEnrolled(await secondFactorStatus(db, accountId))) {
    return undefined;
  }
  return requireRecentAuth(db, accountId, maxAgeSeconds);
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

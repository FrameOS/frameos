import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { jwtVerify, SignJWT } from "jose";
import { cookies } from "next/headers";
import { createDb, sessions } from "@frameos-cloud/db";
import { hasDatabaseUrl } from "./env";
import { derivedSigningKey } from "./keys";
import { hashSecret } from "./secrets";
import {
  sessionAbsoluteMaxAgeSeconds,
  sessionCookieName,
  sessionIdleMaxAgeSeconds,
} from "./session-cookie";

// Cookie naming and lifetime live in ./session-cookie so proxy.ts can refresh
// sessions without importing next/headers. Re-exported here because this
// module is the front door every route handler already imports.
export {
  sessionAbsoluteMaxAgeSeconds,
  sessionCookieName,
  sessionCookieOptions,
  sessionIdleMaxAgeSeconds,
  sessionRefreshIntervalSeconds,
} from "./session-cookie";

export type SessionProfile = {
  accountId?: string | undefined;
  email?: string | undefined;
  emailVerified?: boolean | undefined;
  name?: string | undefined;
  providerIssuer: string;
  providerSubject: string;
};

function secretKey() {
  return derivedSigningKey("session");
}

// Mints the session JWT and records a server-side session row keyed on the
// token hash. The row makes the session revocable: logout (or an operator)
// can invalidate the token before its JWT expiry.
//
// The token itself is minted for the absolute ceiling and never rotates —
// rotating it on refresh would break every request already in flight with the
// old cookie, and the frame hub's long-lived browser sockets, which remember
// the token hash they were opened with. The idle deadline is enforced by the
// row instead, which is where revocation already lives.
export async function createSession(
  db: ReturnType<typeof createDb>,
  profile: SessionProfile & { accountId: string },
) {
  // The jti makes every token unique even when the same account signs in
  // twice within one second; without it the deterministic HS256 payload
  // would collide on the sessions token-hash unique index.
  const token = await new SignJWT({ profile })
    .setProtectedHeader({ alg: "HS256" })
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime(`${sessionAbsoluteMaxAgeSeconds}s`)
    .sign(secretKey());

  const now = Date.now();
  await db.insert(sessions).values({
    absoluteExpiresAt: new Date(now + sessionAbsoluteMaxAgeSeconds * 1000),
    accountId: profile.accountId,
    // A fresh sign-in is the strongest proof there is; sensitive routes
    // accept it for recentAuthMaxAgeSeconds before asking again (recent-auth.ts).
    authenticatedAt: new Date(now),
    expiresAt: new Date(now + sessionIdleMaxAgeSeconds * 1000),
    lastUsedAt: new Date(now),
    tokenHash: hashSecret(token),
  });

  return token;
}

export async function revokeSessionByToken(
  db: ReturnType<typeof createDb>,
  token: string,
) {
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(sessions.tokenHash, hashSecret(token)),
        isNull(sessions.revokedAt),
      ),
    );
}

// The raw session token from the request's cookies, for callers that need to
// address the session row itself (recent-auth.ts) rather than the profile.
export async function readSessionToken() {
  try {
    const cookieStore = await cookies();
    return cookieStore.get(sessionCookieName)?.value;
  } catch {
    return undefined;
  }
}

// Read-only on purpose: this runs inside React Server Components, where
// cookies().set() throws. Extending a session is proxy.ts's job.
export async function readSession() {
  try {
    const cookieStore = await cookies();
    const token = cookieStore.get(sessionCookieName)?.value;
    if (!token) {
      return undefined;
    }

    const verified = await jwtVerify(token, secretKey());
    const profile = verified.payload.profile;
    if (!profile || typeof profile !== "object") {
      return undefined;
    }

    const sessionProfile = profile as SessionProfile;
    if (sessionProfile.accountId && hasDatabaseUrl()) {
      const [row] = await createDb()
        .select({
          absoluteExpiresAt: sessions.absoluteExpiresAt,
          expiresAt: sessions.expiresAt,
          revokedAt: sessions.revokedAt,
        })
        .from(sessions)
        .where(eq(sessions.tokenHash, hashSecret(token)))
        .limit(1);

      const now = new Date();
      if (
        !row ||
        row.revokedAt ||
        row.expiresAt <= now ||
        row.absoluteExpiresAt <= now
      ) {
        return undefined;
      }
    }

    return sessionProfile;
  } catch {
    return undefined;
  }
}

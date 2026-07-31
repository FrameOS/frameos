import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { jwtVerify, SignJWT } from "jose";
import { cookies } from "next/headers";
import { createDb, sessions } from "@frameos-cloud/db";
import { getSessionCookieDomain, hasDatabaseUrl } from "./env";
import { derivedSigningKey } from "./keys";
import { hashSecret } from "./secrets";

// Single source of truth for session lifetime: used for the JWT expiry, the
// cookie maxAge, and the server-side session row so they can never drift.
export const sessionMaxAgeSeconds = 8 * 60 * 60;

// Split production uses a parent-domain cookie so cloud.frameos.net and
// scenes.frameos.net share one login. Domain cookies cannot use __Host-, so
// retain the __Secure- prefix there; single-origin production keeps the more
// restrictive __Host- prefix. Plain-HTTP development uses the bare name.
export const sessionCookieName =
  process.env.NODE_ENV === "production"
    ? getSessionCookieDomain()
      ? "__Secure-frameos_cloud_session"
      : "__Host-frameos_cloud_session"
    : "frameos_cloud_session";

export function sessionCookieOptions() {
  const domain = getSessionCookieDomain();
  return {
    ...(domain ? { domain } : {}),
    httpOnly: true,
    maxAge: sessionMaxAgeSeconds,
    path: "/",
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
  };
}

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
    .setExpirationTime(`${sessionMaxAgeSeconds}s`)
    .sign(secretKey());

  await db.insert(sessions).values({
    accountId: profile.accountId,
    expiresAt: new Date(Date.now() + sessionMaxAgeSeconds * 1000),
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
          expiresAt: sessions.expiresAt,
          revokedAt: sessions.revokedAt,
        })
        .from(sessions)
        .where(eq(sessions.tokenHash, hashSecret(token)))
        .limit(1);

      if (!row || row.revokedAt || row.expiresAt <= new Date()) {
        return undefined;
      }
    }

    return sessionProfile;
  } catch {
    return undefined;
  }
}

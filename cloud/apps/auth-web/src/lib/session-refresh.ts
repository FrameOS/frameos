import { and, eq, gt, isNull, lte, sql } from "drizzle-orm";
import { createDb, sessions } from "@frameos-cloud/db";
import {
  sessionIdleMaxAgeSeconds,
  sessionRefreshIntervalSeconds,
} from "./session-cookie";
import { hashSecret } from "./secrets";

export type RefreshedSession = {
  absoluteExpiresAt: Date;
  expiresAt: Date;
};

// Pushes a live session's idle deadline forward, and reports the new deadlines
// so the caller can re-issue the cookie with a matching maxAge.
//
// Returns undefined when nothing was extended: the session is unknown,
// revoked, past either deadline, or was already refreshed within the throttle
// window. All of that is decided by the single UPDATE below rather than by a
// read-then-write, so concurrent requests cannot race each other into two
// writes and a revocation committed mid-flight always wins.
//
// This is deliberately free of next/headers: it runs from proxy.ts, where the
// RSC cookie API does not exist.
export async function refreshSessionRow(
  db: ReturnType<typeof createDb>,
  token: string,
  now = new Date(),
): Promise<RefreshedSession | undefined> {
  const idleDeadline = new Date(now.getTime() + sessionIdleMaxAgeSeconds * 1000);
  const refreshedBefore = new Date(
    now.getTime() - sessionRefreshIntervalSeconds * 1000,
  );

  const [row] = await db
    .update(sessions)
    .set({
      // The ceiling wins: an old session near its absolute deadline gets a
      // shrinking idle window rather than an extension past the ceiling.
      // The deadline goes in as an explicitly cast ISO string: a raw `sql`
      // fragment bypasses the column's own encoder, and postgres.js cannot
      // bind a Date there.
      expiresAt: sql`least(cast(${idleDeadline.toISOString()} as timestamptz), ${sessions.absoluteExpiresAt})`,
      lastUsedAt: now,
    })
    .where(
      and(
        eq(sessions.tokenHash, hashSecret(token)),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, now),
        gt(sessions.absoluteExpiresAt, now),
        lte(sessions.lastUsedAt, refreshedBefore),
      ),
    )
    .returning({
      absoluteExpiresAt: sessions.absoluteExpiresAt,
      expiresAt: sessions.expiresAt,
    });

  return row;
}

// Seconds of cookie life for a freshly refreshed session: the idle window,
// clamped to what is left of the absolute ceiling.
export function sessionCookieMaxAgeSeconds(
  session: RefreshedSession,
  now = new Date(),
) {
  const remaining = Math.min(
    session.expiresAt.getTime(),
    session.absoluteExpiresAt.getTime(),
  );
  return Math.max(0, Math.floor((remaining - now.getTime()) / 1000));
}

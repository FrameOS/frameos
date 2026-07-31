import { eq, isNull, and } from "drizzle-orm";
import { createDb, linkedClients } from "@frameos-cloud/db";
import { NextRequest, NextResponse } from "next/server";
import { authCookieNames } from "../../src/lib/auth-cookies";
import { getPostLogoutRedirectUrl, hasDatabaseUrl } from "../../src/lib/env";
import { rateLimitResponse } from "../../src/lib/rate-limit";
import {
  readSession,
  revokeSessionByToken,
  sessionCookieName,
  sessionCookieOptions,
} from "../../src/lib/session";

export const runtime = "nodejs";

// Top-level sign-out for linked FrameOS installs: when a user logs out of a
// backend that uses cloud login, the backend sends the browser here so the
// cloud session dies too — otherwise "Continue with FrameOS Cloud" would sign
// them straight back in. GET because it is a cross-origin navigation; forcing
// a logout is a nuisance, not a privilege escalation.
//
// `return_to` must be on the origin of one of the account's linked clients
// (or loopback, for development) so this cannot be used as an open redirect.
export async function GET(request: NextRequest) {
  const limited = rateLimitResponse(request, "auth:logout", {
    limit: 60,
    windowMs: 15 * 60 * 1000,
  });
  if (limited) {
    return limited;
  }

  let redirectTarget = getPostLogoutRedirectUrl();
  const returnTo = request.nextUrl.searchParams.get("return_to");
  const session = await readSession();

  if (returnTo && session?.accountId && hasDatabaseUrl()) {
    const allowed = await returnToAllowed(returnTo, session.accountId);
    if (allowed) {
      redirectTarget = returnTo;
    }
  }

  const sessionToken = request.cookies.get(sessionCookieName)?.value;
  if (sessionToken && hasDatabaseUrl()) {
    await revokeSessionByToken(createDb(), sessionToken);
  }

  const response = NextResponse.redirect(redirectTarget, 303);
  const expiredSessionCookie = {
    ...sessionCookieOptions(),
    expires: new Date(0),
    maxAge: 0,
  };
  const expiredAuthCookie = {
    expires: new Date(0),
    httpOnly: true,
    maxAge: 0,
    path: "/",
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
  };
  response.cookies.set(sessionCookieName, "", expiredSessionCookie);
  response.cookies.set(authCookieNames.state, "", expiredAuthCookie);
  response.cookies.set(authCookieNames.nonce, "", expiredAuthCookie);
  response.cookies.set(authCookieNames.verifier, "", expiredAuthCookie);
  response.cookies.set(authCookieNames.returnTo, "", expiredAuthCookie);
  response.cookies.set(authCookieNames.mergeEmail, "", expiredAuthCookie);
  response.headers.set("Cache-Control", "no-store, max-age=0");
  return response;
}

const loopbackHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

async function returnToAllowed(returnTo: string, accountId: string) {
  let target: URL;
  try {
    target = new URL(returnTo);
  } catch {
    return false;
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return false;
  }
  if (loopbackHosts.has(target.hostname)) {
    return true;
  }

  const rows = await createDb()
    .select({ localOrigin: linkedClients.localOrigin })
    .from(linkedClients)
    .where(
      and(
        eq(linkedClients.accountId, accountId),
        isNull(linkedClients.revokedAt),
      ),
    );
  return rows.some((row) => {
    if (!row.localOrigin) {
      return false;
    }
    try {
      return new URL(row.localOrigin).origin === target.origin;
    } catch {
      return false;
    }
  });
}

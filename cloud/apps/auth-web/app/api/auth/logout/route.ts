import { createDb } from "@frameos-cloud/db";
import { NextRequest, NextResponse } from "next/server";
import { authCookieNames } from "../../../../src/lib/auth-cookies";
import { csrfResponse } from "../../../../src/lib/csrf";
import {
  getPostLogoutRedirectUrl,
  hasDatabaseUrl,
} from "../../../../src/lib/env";
import {
  revokeSessionByToken,
  sessionCookieName,
  sessionCookieOptions,
} from "../../../../src/lib/session";

// Logout is a cookie-authenticated mutation: POST-only with an origin check so
// third-party pages cannot force-logout users via links or images.
export async function POST(request: NextRequest) {
  const csrf = csrfResponse(request);
  if (csrf) {
    return csrf;
  }

  const sessionToken = request.cookies.get(sessionCookieName)?.value;
  if (sessionToken && hasDatabaseUrl()) {
    await revokeSessionByToken(createDb(), sessionToken);
  }

  // 303 turns the POST into a GET against the signed-out login page.
  const response = NextResponse.redirect(getPostLogoutRedirectUrl(), 303);
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
  // Deliberately no Clear-Site-Data: "cache" here. Browsers block the
  // navigation while wiping the origin's disk cache, which makes sign-out
  // take seconds; the sensitive pages already send Cache-Control: no-store,
  // so there is nothing cached worth clearing.
  response.headers.set("Cache-Control", "no-store, max-age=0");
  return response;
}

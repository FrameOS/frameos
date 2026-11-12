// Sign in with Apple on the web, step one: off to Apple with a fresh state
// and nonce (src/lib/apple-sign-in.ts). Apple comes back with a form POST to
// /api/auth/apple/callback.
//
// /login/reauth sends an account with nothing local to check here with
// `reauth=1`, as it sends a Google one to Google. Apple has no "ask again"
// switch the way Google has prompt=login, and needs none: its web sign-in
// asks for the Apple ID's password or the device's Face ID or Touch ID every
// time. The callback mints a fresh session, which counts as recent.
import { createRandomToken } from "@frameos-cloud/auth-client";
import { NextRequest, NextResponse } from "next/server";
import {
  appleAuthorizationUrl,
  appleFlowCookieName,
  appleFlowCookieOptions,
  createAppleFlowToken,
} from "../../../../../src/lib/apple-sign-in";
import { safeAuthReturnPath } from "../../../../../src/lib/auth-cookies";
import { getAppleSignInConfig, getBaseUrl } from "../../../../../src/lib/env";
import { rateLimitResponse } from "../../../../../src/lib/rate-limit";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const limited = await rateLimitResponse(request, "auth:apple-start", {
    limit: 30,
    windowMs: 15 * 60 * 1000,
  });
  if (limited) {
    return limited;
  }

  const config = getAppleSignInConfig();
  if (!config?.servicesId) {
    return NextResponse.redirect(new URL("/login?error=apple_unavailable", getBaseUrl()));
  }

  const state = createRandomToken();
  const nonce = createRandomToken();
  const returnTo = safeAuthReturnPath(request.nextUrl.searchParams.get("return_to"));

  const response = NextResponse.redirect(
    appleAuthorizationUrl({ ...config, servicesId: config.servicesId }, { nonce, state }),
  );
  response.cookies.set(
    appleFlowCookieName,
    await createAppleFlowToken({ nonce, returnTo, state }),
    appleFlowCookieOptions(),
  );
  return response;
}

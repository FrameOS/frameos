import {
  discoverOidcProvider,
  exchangeAuthorizationCode,
  verifyOidcIdToken,
} from "@frameos-cloud/auth-client";
import { createDb } from "@frameos-cloud/db";
import { NextRequest, NextResponse } from "next/server";
import {
  authCookieNames,
  cookieOptions,
  safeAuthReturnPath,
} from "../../../../../src/lib/auth-cookies";
import { resolveGoogleSignIn } from "../../../../../src/lib/google-account";
import {
  getBaseUrl,
  getGoogleCallbackUrl,
  getGoogleOAuthConfig,
} from "../../../../../src/lib/env";
import {
  sessionCookieName,
  sessionCookieOptions,
} from "../../../../../src/lib/session";
import { completeFirstFactor } from "../../../../../src/lib/sign-in";
import { defaultSignInRedirect } from "../../../../../src/lib/sign-in-redirect";
import {
  pendingSignInCookieName,
  pendingSignInCookieOptions,
} from "../../../../../src/lib/two-factor";
import { notifyNewCloudUser } from "../../../../../src/lib/signup-notifications";
import { logWarn, reportError } from "../../../../../src/lib/log";

export async function GET(request: NextRequest) {
  const expectedState = request.cookies.get(authCookieNames.state)?.value;
  const expectedNonce = request.cookies.get(authCookieNames.nonce)?.value;
  const codeVerifier = request.cookies.get(authCookieNames.verifier)?.value;
  const returnTo = safeAuthReturnPath(
    request.cookies.get(authCookieNames.returnTo)?.value,
  );
  const actualState = request.nextUrl.searchParams.get("state");
  const code = request.nextUrl.searchParams.get("code");
  const error = request.nextUrl.searchParams.get("error");

  if (error) {
    // Keep the raw provider error in server logs only; the login page maps
    // known codes to copy and shows a generic message for everything else.
    logWarn("auth.google_provider_error", { detail: error.slice(0, 200) });
    return NextResponse.redirect(
      new URL(`/login?error=${encodeURIComponent(error)}`, getBaseUrl()),
    );
  }

  if (
    !code ||
    !expectedState ||
    !expectedNonce ||
    !codeVerifier ||
    actualState !== expectedState
  ) {
    return NextResponse.redirect(
      new URL("/login?error=invalid_state", getBaseUrl()),
    );
  }

  const config = getGoogleOAuthConfig();
  if (!config) {
    return NextResponse.redirect(
      new URL("/login?error=google_unavailable", getBaseUrl()),
    );
  }

  let discovery;
  let claims;
  try {
    discovery = await discoverOidcProvider(config.issuerUrl);
    const tokenSet = await exchangeAuthorizationCode(discovery, {
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      code,
      codeVerifier,
      redirectUri: getGoogleCallbackUrl(),
    });

    claims = await verifyOidcIdToken(tokenSet.id_token, {
      audience: config.clientId,
      issuer: discovery.issuer,
      jwksUri: discovery.jwks_uri,
      nonce: expectedNonce,
    });
  } catch (error) {
    reportError("auth.google_code_exchange_failed", error);
    return NextResponse.redirect(
      new URL("/login?error=provider_unavailable", getBaseUrl()),
    );
  }

  const db = createDb();

  // Merge rules live in resolveGoogleSignIn: an existing verified password
  // account links automatically; an unverified one requires a password reset
  // first so a squatter's password cannot ride along into this account.
  const resolution = await resolveGoogleSignIn(db, discovery.issuer, claims);

  if (resolution.status === "requires_password_reset") {
    const response = NextResponse.redirect(
      new URL("/login?error=verify_before_google_link", getBaseUrl()),
    );
    response.cookies.set(
      authCookieNames.mergeEmail,
      resolution.email,
      cookieOptions(),
    );
    response.cookies.delete(authCookieNames.state);
    response.cookies.delete(authCookieNames.nonce);
    response.cookies.delete(authCookieNames.verifier);
    response.cookies.delete(authCookieNames.returnTo);
    return response;
  }

  if (resolution.status === "google_email_unverified") {
    const response = NextResponse.redirect(
      new URL("/login?error=google_email_unverified", getBaseUrl()),
    );
    response.cookies.delete(authCookieNames.state);
    response.cookies.delete(authCookieNames.nonce);
    response.cookies.delete(authCookieNames.verifier);
    response.cookies.delete(authCookieNames.returnTo);
    return response;
  }

  const accountId = resolution.accountId;

  // Only a brand new account (not a login or a link into an existing one)
  // announces itself. Fire-and-forget: notifyNewCloudUser never throws and
  // no-ops without its env vars.
  if (resolution.created) {
    void notifyNewCloudUser({
      accountId,
      displayName: claims.name,
      email: claims.email,
      provider: "google",
    });
  }

  const outcome = await completeFirstFactor(db, {
    auditMetadata: {
      email: claims.email,
      emailVerified: claims.email_verified,
    },
    method: "google",
    profile: {
      accountId,
      email: claims.email,
      emailVerified: claims.email_verified,
      name: claims.name,
      providerIssuer: discovery.issuer,
      providerSubject: claims.sub,
    },
    returnTo,
  });

  // Second factor enrolled: park the sign-in in the pending cookie and let
  // /login/verify finish it. Same cleanup of the OAuth cookies as below.
  if (outcome.kind === "second_factor") {
    const response = NextResponse.redirect(
      new URL("/login/verify", getBaseUrl()),
    );
    response.cookies.set(
      pendingSignInCookieName,
      outcome.pendingToken,
      pendingSignInCookieOptions(),
    );
    response.cookies.delete(authCookieNames.state);
    response.cookies.delete(authCookieNames.nonce);
    response.cookies.delete(authCookieNames.verifier);
    response.cookies.delete(authCookieNames.returnTo);
    response.cookies.delete(authCookieNames.mergeEmail);
    return response;
  }
  const sessionToken = outcome.token;

  const response = NextResponse.redirect(
    new URL(returnTo ?? defaultSignInRedirect, getBaseUrl()),
  );
  response.cookies.set(sessionCookieName, sessionToken, sessionCookieOptions());
  response.cookies.delete(authCookieNames.state);
  response.cookies.delete(authCookieNames.nonce);
  response.cookies.delete(authCookieNames.verifier);
  response.cookies.delete(authCookieNames.returnTo);
  response.cookies.delete(authCookieNames.mergeEmail);
  return response;
}

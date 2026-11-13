import {
  discoverOidcProvider,
  exchangeAuthorizationCode,
  verifyOidcIdToken,
} from "@frameos-cloud/auth-client";
import { createDb, googleProviderKey } from "@frameos-cloud/db";
import { NextRequest, NextResponse } from "next/server";
import {
  authCookieNames,
  safeAuthReturnPath,
} from "../../../../../src/lib/auth-cookies";
import {
  getBaseUrl,
  getGoogleCallbackUrl,
  getGoogleOAuthConfig,
} from "../../../../../src/lib/env";
import { finishProviderWebSignIn } from "../../../../../src/lib/provider-callback";
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

  // The merge rules and every outcome (session, second factor, the password
  // check before a link, the login page with a reason) are shared with
  // Apple's callback: src/lib/provider-callback.ts.
  return finishProviderWebSignIn(
    request,
    createDb(),
    {
      claims: {
        email: claims.email,
        email_verified: claims.email_verified,
        name: claims.name,
        sub: claims.sub,
      },
      issuer: discovery.issuer,
      providerKey: googleProviderKey,
      returnTo,
    },
    (response) => {
      response.cookies.delete(authCookieNames.state);
      response.cookies.delete(authCookieNames.nonce);
      response.cookies.delete(authCookieNames.verifier);
    },
  );
}

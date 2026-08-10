import {
  buildAuthorizationUrl,
  createPkcePair,
  createRandomToken,
  discoverOidcProvider,
  frameosCloudAuthScopes,
} from "@frameos-cloud/auth-client";
import { NextRequest, NextResponse } from "next/server";
import {
  authCookieNames,
  cookieOptions,
  safeAuthReturnPath,
} from "../../../../../src/lib/auth-cookies";
import {
  getBaseUrl,
  getGoogleCallbackUrl,
  getGoogleOAuthConfig,
} from "../../../../../src/lib/env";
import { rateLimitResponse } from "../../../../../src/lib/rate-limit";

export async function GET(request: NextRequest) {
  const limited = await rateLimitResponse(request, "auth:google-start", {
    limit: 30,
    windowMs: 15 * 60 * 1000,
  });
  if (limited) {
    return limited;
  }

  const config = getGoogleOAuthConfig();
  if (!config) {
    return NextResponse.redirect(
      new URL("/login?error=google_unavailable", getBaseUrl()),
    );
  }

  let discovery;
  try {
    discovery = await discoverOidcProvider(config.issuerUrl);
  } catch (error) {
    console.error(
      "auth/google/start: OIDC discovery failed:",
      error instanceof Error ? error.message : "unknown error",
    );
    return NextResponse.redirect(
      new URL("/login?error=provider_unavailable", getBaseUrl()),
    );
  }

  const state = createRandomToken();
  const nonce = createRandomToken();
  const pkce = await createPkcePair();
  const returnTo = safeAuthReturnPath(
    request.nextUrl.searchParams.get("return_to"),
  );

  const authorizationUrl = buildAuthorizationUrl(discovery, {
    clientId: config.clientId,
    codeChallenge: pkce.challenge,
    nonce,
    redirectUri: getGoogleCallbackUrl(),
    scopes: [...frameosCloudAuthScopes],
    state,
  });

  const response = NextResponse.redirect(authorizationUrl);
  response.cookies.set(authCookieNames.state, state, cookieOptions());
  response.cookies.set(authCookieNames.nonce, nonce, cookieOptions());
  response.cookies.set(authCookieNames.verifier, pkce.verifier, cookieOptions());
  if (returnTo) {
    response.cookies.set(authCookieNames.returnTo, returnTo, cookieOptions());
  } else {
    response.cookies.delete(authCookieNames.returnTo);
  }
  return response;
}

// Sign in with Apple from the iOS app (docs/auth.md "Sign in with Apple").
// The system's sheet hands the app an identity token and an authorization
// code; the app posts them here with the nonce it hashed into the request:
//
//   POST {identity_token, authorization_code, nonce, given_name?, family_name?}
//
// The identity token must verify (Apple's keys, the app's bundle id as the
// audience, SHA-256 of the nonce), and the code is exchanged at Apple, which
// spends it: a token and code lifted off a device cannot be played again. The
// exchange's own id_token must name the same person. Then the same merge
// rules as the web (src/lib/provider-account.ts), answered in JSON for the app:
//
//   200 {ok, email}                          signed in, session cookie set
//   200 {ok, second_factor_required: true}   the pending cookie is set; the
//                                            app asks for the code, as after
//                                            a password (/api/auth/second-factor/code)
//   409 link_required {email, methods,       an account has this address (a
//        other_ways}
//                                            verified password account, or a
//                                            Google one): the pending-link
//                                            cookie is set, and the app proves
//                                            the account with its password or
//                                            a sign-in through the web's sheet
//                                            (`methods`: provider-link.ts
//                                            linkConfirmMethods), then POSTs
//                                            /api/auth/link
//   409 verify_before_link {email}           an unverified password account
//                                            has it: reset first
//   403 apple_email_unverified, 400 apple_email_missing, 400 invalid_grant,
//   503 apple_unavailable (no key on this cloud)
import {
  appleProviderKey,
  createDb,
  setIdentityProviderToken,
} from "@frameos-cloud/db";
import { NextRequest, NextResponse } from "next/server";
import {
  appleDisplayName,
  appleNonceHash,
  exchangeAppleCode,
  sealAppleToken,
  validAppleNonce,
  verifyAppleIdToken,
} from "../../../../../src/lib/apple-sign-in";
import { csrfResponse } from "../../../../../src/lib/csrf";
import { assertDatabaseUrlConfigured, getAppleSignInConfig } from "../../../../../src/lib/env";
import { logWarn } from "../../../../../src/lib/log";
import { resolveProviderSignIn } from "../../../../../src/lib/provider-account";
import {
  createPendingLinkToken,
  linkConfirmMethods,
  linkConfirmSentence,
  otherSignInWays,
  pendingLinkCookieName,
  pendingLinkCookieOptions,
} from "../../../../../src/lib/provider-link";
import { rateLimitResponse } from "../../../../../src/lib/rate-limit";
import { sessionCookieName, sessionCookieOptions } from "../../../../../src/lib/session";
import { completeFirstFactor } from "../../../../../src/lib/sign-in";
import { notifyNewCloudUser } from "../../../../../src/lib/signup-notifications";
import {
  pendingSignInCookieName,
  pendingSignInCookieOptions,
} from "../../../../../src/lib/two-factor";

export const runtime = "nodejs";

function refuse(status: number, error: string, detail: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ detail, error, ...extra }, { status });
}

function text(value: unknown, max: number) {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined;
}

export async function POST(request: NextRequest) {
  const csrf = csrfResponse(request);
  if (csrf) {
    return csrf;
  }
  const limited = await rateLimitResponse(request, "auth:apple-native", {
    limit: 30,
    windowMs: 15 * 60 * 1000,
  });
  if (limited) {
    return limited;
  }

  const config = getAppleSignInConfig();
  if (!config) {
    return refuse(503, "apple_unavailable", "Sign in with Apple is not set up on this FrameOS Cloud.");
  }

  const body = (await request.json().catch(() => undefined)) as Record<string, unknown> | undefined;
  const identityToken = text(body?.identity_token, 8000);
  const authorizationCode = text(body?.authorization_code, 2000);
  const nonce = body?.nonce;
  if (!identityToken || !authorizationCode || !validAppleNonce(nonce)) {
    return refuse(400, "invalid_request", "The sign-in was incomplete. Try again.");
  }

  let claims;
  let refreshToken;
  try {
    claims = await verifyAppleIdToken(config, identityToken, {
      audience: config.appBundleId,
      nonce: appleNonceHash(nonce),
    });
    const tokens = await exchangeAppleCode(config, {
      clientId: config.appBundleId,
      code: authorizationCode,
    });
    const exchanged = await verifyAppleIdToken(config, tokens.id_token, {
      audience: config.appBundleId,
    });
    if (exchanged.sub !== claims.sub) {
      throw new Error("Apple's code names someone else");
    }
    claims = { ...claims, email: claims.email ?? exchanged.email };
    refreshToken = tokens.refresh_token;
  } catch (error) {
    logWarn("auth.apple_native_refused", {
      detail: error instanceof Error ? error.message.slice(0, 200) : "unknown",
    });
    return refuse(400, "invalid_grant", "Apple's sign-in could not be checked. Try again.");
  }

  assertDatabaseUrlConfigured();
  const db = createDb();
  const providerToken = refreshToken ? sealAppleToken(config.appBundleId, refreshToken) : undefined;
  const name = appleDisplayName(body?.given_name, body?.family_name);
  const resolution = await resolveProviderSignIn(db, appleProviderKey, config.authUrl, {
    email: claims.email,
    email_verified: claims.emailVerified,
    name,
    sub: claims.sub,
  });

  if (resolution.status === "requires_link_confirmation") {
    const methods = await linkConfirmMethods(db, resolution.accountId, appleProviderKey);
    const response = refuse(
      409,
      "link_required",
      linkConfirmSentence(resolution.email, "Sign in with Apple", methods),
      // `other_ways`: the words for the app's "Sign in with …" button.
      { email: resolution.email, methods, other_ways: otherSignInWays(methods) },
    );
    response.cookies.set(
      pendingLinkCookieName,
      await createPendingLinkToken({
        accountId: resolution.accountId,
        email: resolution.email,
        name,
        providerIssuer: config.authUrl,
        providerKey: appleProviderKey,
        providerSubject: claims.sub,
        providerToken,
      }),
      pendingLinkCookieOptions(),
    );
    return response;
  }
  if (resolution.status === "requires_password_reset") {
    return refuse(
      409,
      "verify_before_link",
      `A FrameOS Cloud account with ${resolution.email} exists, but its address was never verified. Reset its password first ("Forgot your password?"), then sign in with Apple again.`,
      { email: resolution.email },
    );
  }
  if (resolution.status === "email_unverified") {
    return refuse(403, "apple_email_unverified", "Apple did not confirm this email address.");
  }
  if (resolution.status === "email_missing") {
    return refuse(
      400,
      "apple_email_missing",
      "Apple did not share an email address. Remove FrameOS under your Apple ID's Sign in with Apple settings, then try again and share an address.",
    );
  }

  const accountId = resolution.accountId;
  if (providerToken) {
    await setIdentityProviderToken(db, config.authUrl, claims.sub, providerToken);
  }
  if (resolution.created) {
    void notifyNewCloudUser({
      accountId,
      analyticsConsent: undefined,
      displayName: name,
      email: claims.email,
      provider: appleProviderKey,
    });
  }

  const outcome = await completeFirstFactor(db, {
    auditMetadata: { app: true, email: claims.email, emailVerified: claims.emailVerified },
    method: "apple",
    profile: {
      accountId,
      email: claims.email,
      emailVerified: claims.emailVerified,
      name,
      providerIssuer: config.authUrl,
      providerSubject: claims.sub,
    },
  });

  if (outcome.kind === "second_factor") {
    const response = NextResponse.json({ ok: true, second_factor_required: true });
    response.cookies.set(pendingSignInCookieName, outcome.pendingToken, pendingSignInCookieOptions());
    return response;
  }
  const response = NextResponse.json({ email: claims.email, ok: true });
  response.cookies.set(sessionCookieName, outcome.token, sessionCookieOptions());
  return response;
}

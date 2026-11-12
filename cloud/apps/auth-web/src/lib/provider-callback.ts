// The web end of a Google or Apple sign-in, once the provider's claims are
// verified: which account they open (provider-account.ts), and the response
// that follows — a session, the second factor, the password check before a
// link, or the login page with a reason. Both callbacks end here so the two
// providers cannot drift apart on the merge rules.

import {
  createDb,
  setIdentityProviderToken,
  type SocialProviderKey,
} from "@frameos-cloud/db";
import { NextRequest, NextResponse } from "next/server";
import { consentCookieName, parseConsent } from "./analytics-consent";
import { authCookieNames, cookieOptions } from "./auth-cookies";
import { getBaseUrl } from "./env";
import { resolveProviderSignIn, type ProviderClaims } from "./provider-account";
import {
  createPendingLinkToken,
  pendingLinkCookieName,
  pendingLinkCookieOptions,
} from "./provider-link";
import { sessionCookieName, sessionCookieOptions } from "./session";
import { completeFirstFactor } from "./sign-in";
import { defaultSignInRedirect } from "./sign-in-redirect";
import { notifyNewCloudUser } from "./signup-notifications";
import { pendingSignInCookieName, pendingSignInCookieOptions } from "./two-factor";

export type ProviderWebSignIn = {
  claims: ProviderClaims;
  issuer: string;
  providerKey: SocialProviderKey;
  // Apple's refresh token, sealed: kept on the identity for the revoke at
  // account deletion.
  providerToken?: string | undefined;
  // 303 for Apple's callback, which is a form POST: a 307 would have the
  // browser post again to wherever it is sent next.
  redirectStatus?: 303 | 307 | undefined;
  returnTo?: string | undefined;
};

// The login page's reason for a sign-in that did not open an account.
export function providerSignInError(
  providerKey: SocialProviderKey,
  status: "email_missing" | "email_unverified",
) {
  return `${providerKey}_${status}`;
}

export async function finishProviderWebSignIn(
  request: NextRequest,
  db: ReturnType<typeof createDb>,
  input: ProviderWebSignIn,
  // The flow's own cookies, cleared on every outcome.
  clearFlowCookies: (response: NextResponse) => void,
): Promise<NextResponse> {
  const { claims, issuer, providerKey, providerToken, returnTo } = input;
  const redirect = (path: string) =>
    NextResponse.redirect(new URL(path, getBaseUrl()), input.redirectStatus ?? 307);
  const finish = (response: NextResponse) => {
    clearFlowCookies(response);
    response.cookies.delete(authCookieNames.returnTo);
    return response;
  };
  const toLogin = (error: string) =>
    finish(redirect(`/login?error=${encodeURIComponent(error)}`));

  // Merge rules live in resolveProviderSignIn: an existing account (a
  // verified password account, or one that signs in through the other
  // provider) links only after the visitor proves it on /login/link; an
  // unverified password account requires a password reset first so a
  // squatter's password cannot ride along into this account.
  const resolution = await resolveProviderSignIn(db, providerKey, issuer, claims);

  if (resolution.status === "requires_link_confirmation") {
    // The verified claims are parked in a signed, short-lived cookie; the
    // link route re-reads them once the account is proved (its password, or
    // a fresh sign-in to it). Nothing is written to the account until then.
    const response = redirect("/login/link");
    response.cookies.set(
      pendingLinkCookieName,
      await createPendingLinkToken({
        accountId: resolution.accountId,
        email: resolution.email,
        name: claims.name,
        providerIssuer: issuer,
        providerKey,
        providerSubject: claims.sub,
        providerToken,
        returnTo,
      }),
      pendingLinkCookieOptions(),
    );
    response.cookies.delete(authCookieNames.mergeEmail);
    return finish(response);
  }

  if (resolution.status === "requires_password_reset") {
    const response = toLogin(`verify_before_${providerKey}_link`);
    response.cookies.set(authCookieNames.mergeEmail, resolution.email, cookieOptions());
    return response;
  }

  if (resolution.status === "email_unverified" || resolution.status === "email_missing") {
    return toLogin(providerSignInError(providerKey, resolution.status));
  }

  const accountId = resolution.accountId;
  if (providerToken) {
    await setIdentityProviderToken(db, issuer, claims.sub, providerToken);
  }

  // Only a brand new account (not a login or a link into an existing one)
  // announces itself. Fire-and-forget: notifyNewCloudUser never throws and
  // no-ops without its env vars.
  if (resolution.created) {
    void notifyNewCloudUser({
      accountId,
      analyticsConsent: parseConsent(request.cookies.get(consentCookieName)?.value),
      displayName: claims.name,
      email: claims.email,
      provider: providerKey,
    });
  }

  const outcome = await completeFirstFactor(db, {
    auditMetadata: {
      email: claims.email,
      emailVerified: claims.email_verified,
    },
    method: providerKey,
    profile: {
      accountId,
      email: claims.email,
      emailVerified: claims.email_verified,
      name: claims.name,
      providerIssuer: issuer,
      providerSubject: claims.sub,
    },
    returnTo,
  });

  // Second factor enrolled: park the sign-in in the pending cookie and let
  // /login/verify finish it.
  if (outcome.kind === "second_factor") {
    const response = redirect("/login/verify");
    response.cookies.set(pendingSignInCookieName, outcome.pendingToken, pendingSignInCookieOptions());
    response.cookies.delete(authCookieNames.mergeEmail);
    return finish(response);
  }

  const response = redirect(returnTo ?? defaultSignInRedirect);
  response.cookies.set(sessionCookieName, outcome.token, sessionCookieOptions());
  response.cookies.delete(authCookieNames.mergeEmail);
  return finish(response);
}

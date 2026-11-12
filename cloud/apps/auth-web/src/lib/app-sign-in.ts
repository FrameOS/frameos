// Signing in to a native app (the FrameOS iOS app) with whatever signs in to
// the web: Google, a passkey, a password, two-factor. The app cannot read a
// browser's cookies, so the browser hands it a session instead
// (cloud/docs/auth.md "Signing in to the app"):
//
//   1. The app opens GET /api/auth/app/authorize?code_challenge=…&state=…
//      in the system's sign-in sheet (ASWebAuthenticationSession). The route
//      wraps the request in a signed token and sends the person through the
//      usual /login (or straight to Google or Apple, provider=google|apple).
//   2. Signed in, the route redirects to frameos://sign-in with a code: a
//      two-minute signed token naming the account and identity by id (no
//      email in the URL) and the browser session's `authenticated_at`.
//   3. The app posts the code with its PKCE verifier to /api/auth/app/token,
//      which spends it once (claimSingleUse) and answers with a new session
//      cookie for the app.
//
// The app's session inherits `authenticated_at` from the browser session that
// authorized it, so a code never turns an old browser session into a fresh
// one for sudo mode (recent-auth.ts). A browser session from before the
// request is not used silently: the person is asked first (/login/app).

import { createHash, randomUUID } from "node:crypto";
import { jwtVerify, SignJWT, type JWTPayload } from "jose";
import { derivedSigningKey } from "./keys";

// The one place a code goes. The app's sign-in sheet catches this scheme;
// nothing else is accepted, so a request cannot send a code anywhere else.
export const appSignInCallback = "frameos://sign-in";

export const appSignInCodeMaxAgeSeconds = 2 * 60;
const requestMaxAgeSeconds = 10 * 60;
const requestType = "app_sign_in_request";
const codeType = "app_sign_in_code";
export const maxAppSignInStateChars = 512;

export type AppSignInProvider = "apple" | "google";

export function appSignInProvider(value: unknown): AppSignInProvider | undefined {
  return value === "google" || value === "apple" ? value : undefined;
}

export type AppSignInRequest = {
  challenge: string;
  // Seconds, from the token's iat: a browser session authenticated before
  // this is asked about (/login/app), not used silently.
  issuedAt: number;
  provider?: AppSignInProvider | undefined;
  reauth: boolean;
  state: string;
};

export type AppSignInCode = {
  accountId: string;
  authenticatedAt: Date;
  challenge: string;
  codeId: string;
  identityId: string;
};

// RFC 7636: S256 of a 32-byte verifier is 43 base64url characters.
const challengeShape = /^[A-Za-z0-9_-]{43}$/;
const verifierShape = /^[A-Za-z0-9._~-]{43,128}$/;

export function validChallenge(value: unknown): value is string {
  return typeof value === "string" && challengeShape.test(value);
}

export function validState(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxAppSignInStateChars &&
    // Rides back in a URL query and inside a signed token: printable ASCII only.
    /^[\x21-\x7e]+$/.test(value)
  );
}

export function pkceChallenge(verifier: string) {
  return createHash("sha256").update(verifier).digest("base64url");
}

// True when the verifier is well formed and hashes to the challenge.
export function pkceMatches(verifier: unknown, challenge: string) {
  return (
    typeof verifier === "string" &&
    verifierShape.test(verifier) &&
    pkceChallenge(verifier) === challenge
  );
}

export function appSignInCallbackUrl(params: Record<string, string>) {
  const url = new URL(appSignInCallback);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

export async function createAppSignInRequestToken(
  request: Omit<AppSignInRequest, "issuedAt">,
) {
  const payload: JWTPayload & Record<string, unknown> = {
    challenge: request.challenge,
    frameos_type: requestType,
    reauth: request.reauth,
    state: request.state,
  };
  if (request.provider) {
    payload.provider = request.provider;
  }
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${requestMaxAgeSeconds}s`)
    .sign(derivedSigningKey("app-sign-in-request"));
}

export async function verifyAppSignInRequestToken(
  token: string,
): Promise<AppSignInRequest | undefined> {
  try {
    const { payload } = await jwtVerify(token, derivedSigningKey("app-sign-in-request"), {
      algorithms: ["HS256"],
    });
    if (
      payload.frameos_type !== requestType ||
      !validChallenge(payload.challenge) ||
      !validState(payload.state) ||
      typeof payload.iat !== "number"
    ) {
      return undefined;
    }
    return {
      challenge: payload.challenge,
      issuedAt: payload.iat,
      provider: appSignInProvider(payload.provider),
      reauth: payload.reauth === true,
      state: payload.state,
    };
  } catch {
    return undefined;
  }
}

export async function createAppSignInCode(code: Omit<AppSignInCode, "codeId">) {
  return new SignJWT({
    account_id: code.accountId,
    authenticated_at: code.authenticatedAt.getTime(),
    challenge: code.challenge,
    frameos_type: codeType,
    identity_id: code.identityId,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime(`${appSignInCodeMaxAgeSeconds}s`)
    .sign(derivedSigningKey("app-sign-in-code"));
}

export async function verifyAppSignInCode(
  code: string,
): Promise<AppSignInCode | undefined> {
  try {
    const { payload } = await jwtVerify(code, derivedSigningKey("app-sign-in-code"), {
      algorithms: ["HS256"],
    });
    if (
      payload.frameos_type !== codeType ||
      typeof payload.jti !== "string" ||
      typeof payload.account_id !== "string" ||
      typeof payload.identity_id !== "string" ||
      typeof payload.authenticated_at !== "number" ||
      !validChallenge(payload.challenge)
    ) {
      return undefined;
    }
    return {
      accountId: payload.account_id,
      authenticatedAt: new Date(payload.authenticated_at),
      challenge: payload.challenge,
      codeId: payload.jti,
      identityId: payload.identity_id,
    };
  } catch {
    return undefined;
  }
}

// True for a sign-in page on its way back to the app (the return_to the
// authorize route sends it with): the page is in the app's sign-in sheet.
export function isAppSignInReturn(returnTo: string | null | undefined) {
  return typeof returnTo === "string" && returnTo.startsWith("/api/auth/app/authorize?");
}

// The single-use key a code is spent under (rate-limit.ts claimSingleUse).
export function appSignInCodeClaimKey(codeId: string) {
  return `app-sign-in-code:${codeId}`;
}

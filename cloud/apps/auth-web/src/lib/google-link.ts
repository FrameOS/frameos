// The "pending Google link": a Google sign-in whose verified email matches an
// existing, verified password account. The callback route does NOT link the
// two on the strength of Google's word alone — the visitor must also prove
// the account's password on /login/link-google. Between the two steps the
// verified Google claims ride this short-lived signed token in an httpOnly
// cookie, the same shape as the pending-sign-in token in ./two-factor.ts:
// it grants nothing on its own, it only says "Google vouched for these
// claims a moment ago in this browser".

import { randomUUID } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";
import { derivedSigningKey } from "./keys";

export const pendingGoogleLinkCookieName = "frameos_google_link_pending";
export const pendingGoogleLinkMaxAgeSeconds = 10 * 60;

export type PendingGoogleLink = {
  // The verified password account the identity would attach to.
  accountId: string;
  // Google's claims, already verified by the callback (issuer, audience,
  // nonce, JWKS). `email` is the Google-attested address, equal to the
  // account's password email.
  email: string;
  name?: string | undefined;
  providerIssuer: string;
  providerSubject: string;
  returnTo?: string | undefined;
};

export type PendingGoogleLinkToken = PendingGoogleLink & { tokenId: string };

function pendingKey() {
  return derivedSigningKey("pending-google-link");
}

export async function createPendingGoogleLinkToken(pending: PendingGoogleLink) {
  return new SignJWT({ purpose: "google-link", pending })
    .setProtectedHeader({ alg: "HS256" })
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime(`${pendingGoogleLinkMaxAgeSeconds}s`)
    .sign(pendingKey());
}

export async function readPendingGoogleLinkToken(
  token: string | undefined,
): Promise<PendingGoogleLinkToken | undefined> {
  if (!token) {
    return undefined;
  }
  try {
    const verified = await jwtVerify(token, pendingKey());
    if (verified.payload.purpose !== "google-link") {
      return undefined;
    }
    const pending = verified.payload.pending as PendingGoogleLink | undefined;
    if (
      !pending ||
      typeof pending !== "object" ||
      typeof pending.accountId !== "string" ||
      typeof pending.email !== "string" ||
      typeof pending.providerIssuer !== "string" ||
      typeof pending.providerSubject !== "string" ||
      typeof verified.payload.jti !== "string"
    ) {
      return undefined;
    }
    return { ...pending, tokenId: verified.payload.jti };
  } catch {
    return undefined;
  }
}

export function pendingGoogleLinkCookieOptions() {
  return {
    httpOnly: true,
    maxAge: pendingGoogleLinkMaxAgeSeconds,
    path: "/",
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
  };
}

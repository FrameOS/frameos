// The "pending link": a Google or Apple sign-in whose verified email matches
// an existing, verified password account. The callback does NOT link the two
// on the strength of the provider's word alone: the visitor must also prove
// the account's password on /login/link (or, in the iOS app, in its own
// password field). Between the two steps the verified claims ride this
// short-lived signed token in an httpOnly cookie, the same shape as the
// pending-sign-in token in ./two-factor.ts: it grants nothing on its own, it
// only says "the provider vouched for these claims a moment ago in this
// browser".

import { randomUUID } from "node:crypto";
import type { SocialProviderKey } from "@frameos-cloud/db";
import { jwtVerify, SignJWT } from "jose";
import { derivedSigningKey } from "./keys";

export const pendingLinkCookieName = "frameos_link_pending";
export const pendingLinkMaxAgeSeconds = 10 * 60;

export type PendingLink = {
  // The verified password account the identity would attach to.
  accountId: string;
  // The provider's claims, already verified by the callback (issuer,
  // audience, nonce, keys). `email` is the provider-attested address, equal
  // to the account's password email.
  email: string;
  name?: string | undefined;
  providerIssuer: string;
  providerKey: SocialProviderKey;
  providerSubject: string;
  // Apple's refresh token, sealed (apple-sign-in.ts sealAppleToken): stored
  // on the identity once it is linked, for revoking at account deletion.
  providerToken?: string | undefined;
  returnTo?: string | undefined;
};

export type PendingLinkToken = PendingLink & { tokenId: string };

function pendingKey() {
  return derivedSigningKey("pending-provider-link");
}

export async function createPendingLinkToken(pending: PendingLink) {
  return new SignJWT({ purpose: "provider-link", pending })
    .setProtectedHeader({ alg: "HS256" })
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime(`${pendingLinkMaxAgeSeconds}s`)
    .sign(pendingKey());
}

export async function readPendingLinkToken(
  token: string | undefined,
): Promise<PendingLinkToken | undefined> {
  if (!token) {
    return undefined;
  }
  try {
    const verified = await jwtVerify(token, pendingKey(), {
      algorithms: ["HS256"],
    });
    if (verified.payload.purpose !== "provider-link") {
      return undefined;
    }
    const pending = verified.payload.pending as PendingLink | undefined;
    if (
      !pending ||
      typeof pending !== "object" ||
      typeof pending.accountId !== "string" ||
      typeof pending.email !== "string" ||
      typeof pending.providerIssuer !== "string" ||
      (pending.providerKey !== "google" && pending.providerKey !== "apple") ||
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

export function pendingLinkCookieOptions() {
  return {
    httpOnly: true,
    maxAge: pendingLinkMaxAgeSeconds,
    path: "/",
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
  };
}

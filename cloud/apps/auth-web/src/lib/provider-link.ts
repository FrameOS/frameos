// The "pending link": a Google or Apple sign-in whose verified email matches
// an existing account (a verified password account, or one that signs in
// through the other provider). The callback does NOT link the two on the
// strength of the provider's word alone: the visitor must also prove the
// account, with its password or with a fresh sign-in to it any way it has
// (`linkConfirmMethods`), on /login/link or in the iOS app. Between the two
// steps the verified claims ride this short-lived signed token in an
// httpOnly cookie, the same shape as the pending-sign-in token in
// ./two-factor.ts: it grants nothing on its own, it only says "the provider
// vouched for these claims a moment ago in this browser".

import { randomUUID } from "node:crypto";
import { count, eq } from "drizzle-orm";
import {
  accountPasskeys,
  accounts,
  accountSocialProviders,
  type createDb,
  type SocialProviderKey,
} from "@frameos-cloud/db";
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

// How the visitor can prove the account a pending link names. `password`:
// type it (POST /api/auth/link {password}). Otherwise, or as well: sign in
// to the account with a passkey or one of `providers` (never the provider
// being linked, which is not on the account yet), and the fresh session is
// the proof (POST /api/auth/link with no password).
export type LinkConfirmMethods = {
  passkey: boolean;
  password: boolean;
  providers: SocialProviderKey[];
};

export async function linkConfirmMethods(
  db: ReturnType<typeof createDb>,
  accountId: string,
  linking: SocialProviderKey,
): Promise<LinkConfirmMethods> {
  const [account] = await db
    .select({ passwordHash: accounts.passwordHash })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  const [passkeys] = await db
    .select({ total: count() })
    .from(accountPasskeys)
    .where(eq(accountPasskeys.accountId, accountId));
  const providers = await accountSocialProviders(db, accountId);
  return {
    passkey: (passkeys?.total ?? 0) > 0,
    password: Boolean(account?.passwordHash),
    providers: providers.filter((key) => key !== linking),
  };
}

const providerNames: Record<SocialProviderKey, string> = {
  apple: "Apple",
  google: "Google",
};

// "Google or a passkey": the ways in other than a password, for the copy.
export function otherSignInWays(methods: LinkConfirmMethods) {
  const ways = [
    ...methods.providers.map((key) => providerNames[key]),
    ...(methods.passkey ? ["a passkey"] : []),
  ];
  if (ways.length <= 1) {
    return ways[0];
  }
  return `${ways.slice(0, -1).join(", ")} or ${ways[ways.length - 1]}`;
}

// What the app and /login/link say about a pending link. `method` is
// "Sign in with Apple" or "Google sign-in".
export function linkConfirmSentence(
  email: string,
  method: string,
  methods: LinkConfirmMethods,
) {
  const exists = `A FrameOS Cloud account with ${email} already exists.`;
  const others = otherSignInWays(methods);
  if (methods.password && others) {
    return `${exists} Enter its password, or sign in to it with ${others}, to connect ${method} to it.`;
  }
  if (methods.password) {
    return `${exists} Enter its password to connect ${method} to it.`;
  }
  return `${exists} Sign in to it once with ${others ?? "the way you usually do"} to connect ${method} to it.`;
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

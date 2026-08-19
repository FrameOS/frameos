// Passkeys (WebAuthn) for cloud accounts, on top of @simplewebauthn/server.
//
// A passkey serves two roles:
// - as a SECOND factor after password/Google sign-in (the pending-sign-in
//   token from ./two-factor.ts proves the first factor, the assertion the
//   second), and
// - as a PASSWORDLESS first-and-second factor: a discoverable credential with
//   user verification signs the account in on its own. The browser picks the
//   account; we only learn which credential answered.
//
// Challenges are stateless: the options call mints a short-lived signed JWT
// (httpOnly cookie) carrying the challenge and, for the second-factor and
// registration cases, the account it was issued for; the verify call must
// present the same cookie. Nothing is stored server-side until a credential is
// actually registered.

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { and, eq } from "drizzle-orm";
import { jwtVerify, SignJWT } from "jose";
import { accountPasskeys, type createDb } from "@frameos-cloud/db";
import { getAppOrigins, getCloudBaseUrl } from "./env";
import { derivedSigningKey } from "./keys";

export const webauthnChallengeCookieName = "frameos_webauthn_challenge";
export const webauthnChallengeMaxAgeSeconds = 5 * 60;
export const passkeyNameMaxLength = 64;
export const maxPasskeysPerAccount = 10;

export const rpName = "FrameOS Cloud";

// The relying-party id must be a registrable suffix of every origin that runs
// the passkey ceremonies (login on the cloud origin, management on the
// account origin — the same host in production). FRAMEOS_WEBAUTHN_RP_ID
// overrides for deployments that split those across subdomains; set it to
// the common parent domain.
export function rpID() {
  const configured = process.env.FRAMEOS_WEBAUTHN_RP_ID?.trim();
  if (configured) {
    return configured.toLowerCase();
  }
  return new URL(getCloudBaseUrl()).hostname.toLowerCase();
}

export function expectedOrigins() {
  return [...getAppOrigins()];
}

export function webauthnChallengeCookieOptions() {
  return {
    httpOnly: true,
    maxAge: webauthnChallengeMaxAgeSeconds,
    path: "/",
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
  };
}

type ChallengePurpose = "authenticate" | "register" | "second_factor";

type ChallengeClaims = {
  accountId?: string | undefined;
  challenge: string;
  purpose: ChallengePurpose;
};

function challengeKey() {
  return derivedSigningKey("webauthn-challenge");
}

export async function createChallengeToken(claims: ChallengeClaims) {
  return new SignJWT({ webauthn: claims })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${webauthnChallengeMaxAgeSeconds}s`)
    .sign(challengeKey());
}

export async function readChallengeToken(
  token: string | undefined,
  purpose: ChallengePurpose,
) {
  if (!token) {
    return undefined;
  }
  try {
    const verified = await jwtVerify(token, challengeKey());
    const claims = verified.payload.webauthn as ChallengeClaims | undefined;
    if (
      !claims ||
      typeof claims !== "object" ||
      claims.purpose !== purpose ||
      typeof claims.challenge !== "string"
    ) {
      return undefined;
    }
    return claims;
  } catch {
    return undefined;
  }
}

function transportsFrom(value: string[] | null | undefined) {
  return (value ?? []) as AuthenticatorTransportFuture[];
}

export async function listAccountPasskeys(
  db: ReturnType<typeof createDb>,
  accountId: string,
) {
  return db
    .select()
    .from(accountPasskeys)
    .where(eq(accountPasskeys.accountId, accountId));
}

// ---------------------------------------------------------------------------
// Registration

export async function passkeyRegistrationOptions(
  db: ReturnType<typeof createDb>,
  account: { email: string; id: string; name?: string | undefined },
) {
  const existing = await listAccountPasskeys(db, account.id);
  const options = await generateRegistrationOptions({
    attestationType: "none",
    authenticatorSelection: {
      // Discoverable + verified, so the same passkey can also sign in
      // passwordlessly; "preferred" keeps security keys without PIN usable
      // as a plain second factor.
      residentKey: "preferred",
      userVerification: "preferred",
    },
    excludeCredentials: existing.map((row) => ({
      id: row.credentialId,
      transports: transportsFrom(row.transports),
    })),
    rpID: rpID(),
    rpName,
    userDisplayName: account.name ?? account.email,
    // Stable per account so re-registering replaces instead of duplicating
    // in the authenticator's own list.
    userID: new TextEncoder().encode(account.id),
    userName: account.email,
  });
  return options;
}

export async function verifyPasskeyRegistration(
  response: RegistrationResponseJSON,
  expectedChallenge: string,
) {
  const verification = await verifyRegistrationResponse({
    expectedChallenge,
    expectedOrigin: expectedOrigins(),
    expectedRPID: rpID(),
    requireUserVerification: false,
    response,
  });
  if (!verification.verified) {
    return undefined;
  }
  return verification.registrationInfo;
}

export async function storePasskey(
  db: ReturnType<typeof createDb>,
  accountId: string,
  name: string,
  info: NonNullable<
    Awaited<ReturnType<typeof verifyPasskeyRegistration>>
  >,
  transports: string[] | undefined,
) {
  const [row] = await db
    .insert(accountPasskeys)
    .values({
      aaguid: info.aaguid,
      accountId,
      backedUp: info.credentialBackedUp,
      counter: info.credential.counter,
      credentialId: info.credential.id,
      deviceType: info.credentialDeviceType,
      name,
      publicKey: Buffer.from(info.credential.publicKey),
      transports: transports ?? info.credential.transports ?? [],
    })
    .onConflictDoNothing({ target: accountPasskeys.credentialId })
    .returning({ id: accountPasskeys.id });
  return row?.id;
}

// ---------------------------------------------------------------------------
// Authentication

// Second-factor assertion: restricted to the account's own credentials.
export async function passkeySecondFactorOptions(
  db: ReturnType<typeof createDb>,
  accountId: string,
) {
  const existing = await listAccountPasskeys(db, accountId);
  return generateAuthenticationOptions({
    allowCredentials: existing.map((row) => ({
      id: row.credentialId,
      transports: transportsFrom(row.transports),
    })),
    rpID: rpID(),
    userVerification: "preferred",
  });
}

// Passwordless assertion: any discoverable credential, verification required
// because this one step is the whole sign-in.
export async function passkeySignInOptions() {
  return generateAuthenticationOptions({
    allowCredentials: [],
    rpID: rpID(),
    userVerification: "required",
  });
}

export type PasskeyAssertionResult = {
  accountId: string;
  passkeyId: string;
  passkeyName: string;
  userVerified: boolean;
};

// Verifies an assertion against the stored credential it names. When
// `accountId` is given the credential must belong to that account (second
// factor); otherwise the credential decides the account (passwordless).
export async function verifyPasskeyAssertion(
  db: ReturnType<typeof createDb>,
  response: AuthenticationResponseJSON,
  expectedChallenge: string,
  options: { accountId?: string | undefined; requireUserVerification: boolean },
): Promise<PasskeyAssertionResult | undefined> {
  if (typeof response?.id !== "string") {
    return undefined;
  }
  const [row] = await db
    .select()
    .from(accountPasskeys)
    .where(
      options.accountId
        ? and(
            eq(accountPasskeys.credentialId, response.id),
            eq(accountPasskeys.accountId, options.accountId),
          )
        : eq(accountPasskeys.credentialId, response.id),
    )
    .limit(1);
  if (!row) {
    return undefined;
  }
  let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
  try {
    verification = await verifyAuthenticationResponse({
      credential: {
        counter: row.counter,
        id: row.credentialId,
        publicKey: new Uint8Array(row.publicKey),
        transports: transportsFrom(row.transports),
      },
      expectedChallenge,
      expectedOrigin: expectedOrigins(),
      expectedRPID: rpID(),
      requireUserVerification: options.requireUserVerification,
      response,
    });
  } catch {
    return undefined;
  }
  if (!verification.verified) {
    return undefined;
  }
  const now = new Date();
  await db
    .update(accountPasskeys)
    .set({
      backedUp: verification.authenticationInfo.credentialBackedUp,
      counter: verification.authenticationInfo.newCounter,
      lastUsedAt: now,
    })
    .where(eq(accountPasskeys.id, row.id));
  return {
    accountId: row.accountId,
    passkeyId: row.id,
    passkeyName: row.name,
    userVerified: verification.authenticationInfo.userVerified,
  };
}

export function normalizePasskeyName(value: unknown, fallback: string) {
  const name = typeof value === "string" ? value.trim() : "";
  return (name || fallback).slice(0, passkeyNameMaxLength);
}

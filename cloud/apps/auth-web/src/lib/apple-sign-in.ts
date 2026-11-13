// Sign in with Apple (docs/auth.md "Sign in with Apple").
//
// Two clients, one Apple key:
// - the web: GET /api/auth/apple/start sends the browser to Apple, which
//   answers with a form POST to /api/auth/apple/callback (Apple's only way to
//   hand over the person's name). That POST is cross-site, so the flow's state
//   and nonce ride a signed cookie of their own that is SameSite=None.
// - the iOS app: the system's Sign in with Apple sheet hands the app an
//   identity token and an authorization code, which it posts to
//   /api/auth/apple/native.
// Both end with a code exchange at Apple. The exchange is what makes a code
// single-use (Apple spends it), and it hands out the refresh token that
// account deletion must revoke (Apple's requirement for apps offering its
// sign-in).

import { createHash, randomUUID } from "node:crypto";
import {
  accountProviderTokens,
  appleProviderKey,
  type createDb,
} from "@frameos-cloud/db";
import {
  createRemoteJWKSet,
  importPKCS8,
  jwtVerify,
  SignJWT,
  type JWTVerifyGetKey,
} from "jose";
import {
  getAppleCallbackUrl,
  getAppleSignInConfig,
  type AppleSignInConfig,
} from "./env";
import { derivedSigningKey } from "./keys";
import { reportError } from "./log";
import { decryptSecret, encryptSecret } from "./secrets";

export const appleScopes = "name email";

// What Apple says about the person, after the token was verified.
export type AppleClaims = {
  email?: string | undefined;
  emailVerified: boolean;
  isPrivateEmail: boolean;
  sub: string;
};

export type AppleTokenSet = {
  id_token: string;
  refresh_token?: string | undefined;
};

export class AppleSignInError extends Error {
  constructor(
    message: string,
    // Apple's own error word when it gave one (`invalid_grant`, …), for logs.
    readonly appleError?: string,
  ) {
    super(message);
    this.name = "AppleSignInError";
  }
}

// The client secret Apple wants instead of a static one: a short-lived ES256
// JWT signed with the team's Sign in with Apple key, naming the client it
// speaks for. Five minutes is plenty for the one request it is made for.
export async function appleClientSecret(
  config: AppleSignInConfig,
  clientId: string,
  now = new Date(),
) {
  const key = await importPKCS8(config.privateKey, "ES256");
  const issuedAt = Math.floor(now.getTime() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: config.keyId })
    .setIssuer(config.teamId)
    .setSubject(clientId)
    .setAudience(config.authUrl)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + 5 * 60)
    .sign(key);
}

export function appleAuthorizationUrl(
  config: AppleSignInConfig & { servicesId: string },
  options: { nonce: string; state: string },
) {
  const url = new URL(`${config.authUrl}/auth/authorize`);
  url.searchParams.set("client_id", config.servicesId);
  url.searchParams.set("nonce", options.nonce);
  url.searchParams.set("redirect_uri", getAppleCallbackUrl());
  url.searchParams.set("response_mode", "form_post");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", appleScopes);
  url.searchParams.set("state", options.state);
  return url;
}

// The code for tokens. `redirectUri` only for the web's codes: the app's
// were issued without one.
export async function exchangeAppleCode(
  config: AppleSignInConfig,
  options: { clientId: string; code: string; redirectUri?: string | undefined },
): Promise<AppleTokenSet> {
  const body = new URLSearchParams({
    client_id: options.clientId,
    client_secret: await appleClientSecret(config, options.clientId),
    code: options.code,
    grant_type: "authorization_code",
  });
  if (options.redirectUri) {
    body.set("redirect_uri", options.redirectUri);
  }
  const response = await fetch(`${config.authUrl}/auth/token`, {
    body,
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    method: "POST",
    signal: AbortSignal.timeout(15_000),
  });
  const payload = (await response.json().catch(() => undefined)) as
    | { error?: unknown; id_token?: unknown; refresh_token?: unknown }
    | undefined;
  if (!response.ok || typeof payload?.id_token !== "string") {
    throw new AppleSignInError(
      `Apple token exchange failed: ${response.status}`,
      typeof payload?.error === "string" ? payload.error.slice(0, 60) : undefined,
    );
  }
  return {
    id_token: payload.id_token,
    refresh_token:
      typeof payload.refresh_token === "string" ? payload.refresh_token : undefined,
  };
}

// One key set per Apple URL for the life of the process: jose caches the
// keys and refetches when Apple rotates one in.
const keySets = new Map<string, JWTVerifyGetKey>();

function appleKeySet(config: AppleSignInConfig) {
  let keySet = keySets.get(config.authUrl);
  if (!keySet) {
    keySet = createRemoteJWKSet(new URL(`${config.authUrl}/auth/keys`));
    keySets.set(config.authUrl, keySet);
  }
  return keySet;
}

// Apple's id_token: RS256 from Apple's keys, Apple as the issuer, the client
// it was issued to as the audience. `nonce` is checked when given (the web's
// round trip and the app's request carry one; a token from the code exchange
// is compared with the one the app sent instead).
export async function verifyAppleIdToken(
  config: AppleSignInConfig,
  idToken: string,
  options: { audience: string; nonce?: string | undefined },
): Promise<AppleClaims> {
  let payload;
  try {
    ({ payload } = await jwtVerify(idToken, appleKeySet(config), {
      algorithms: ["RS256"],
      audience: options.audience,
      issuer: config.authUrl,
    }));
  } catch (error) {
    throw new AppleSignInError(
      `Apple id_token did not verify: ${error instanceof Error ? error.message : "unknown"}`,
    );
  }
  if (options.nonce !== undefined && payload.nonce !== options.nonce) {
    throw new AppleSignInError("Apple id_token nonce mismatch");
  }
  if (typeof payload.sub !== "string" || !payload.sub) {
    throw new AppleSignInError("Apple id_token is missing its subject");
  }
  const email =
    typeof payload.email === "string" && payload.email.includes("@")
      ? payload.email.trim()
      : undefined;
  return {
    email,
    // Apple sends these as booleans or as the strings "true" / "false".
    emailVerified: appleFlag(payload.email_verified),
    isPrivateEmail: appleFlag(payload.is_private_email),
    sub: payload.sub,
  };
}

function appleFlag(value: unknown) {
  return value === true || value === "true";
}

// The app hashes its nonce before handing it to Apple, so the token carries
// SHA-256(nonce) in hex; the app sends the nonce itself to the cloud.
export function appleNonceHash(nonce: string) {
  return createHash("sha256").update(nonce).digest("hex");
}

export function validAppleNonce(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._~-]{16,128}$/.test(value);
}

// The person's name, which Apple gives once: the first time they sign in to
// this team's apps (the web's `user` form field, the app's fullName).
export function appleDisplayName(
  given: unknown,
  family: unknown,
): string | undefined {
  const parts = [given, family]
    .filter((part): part is string => typeof part === "string")
    .map((part) => part.trim())
    .filter(Boolean);
  const name = parts.join(" ").slice(0, 100);
  return name || undefined;
}

// The web's `user` field: {"name": {"firstName", "lastName"}, "email"}.
export function appleDisplayNameFromUserField(raw: string | null | undefined) {
  if (!raw || raw.length > 2000) {
    return undefined;
  }
  try {
    const user = JSON.parse(raw) as { name?: { firstName?: unknown; lastName?: unknown } };
    return appleDisplayName(user?.name?.firstName, user?.name?.lastName);
  } catch {
    return undefined;
  }
}

// What account_identities.provider_token_encrypted holds for an Apple
// identity: the refresh token and the client it was issued to (a revoke must
// name that client).
export function sealAppleToken(clientId: string, refreshToken: string) {
  return encryptSecret(
    JSON.stringify({ client_id: clientId, refresh_token: refreshToken }),
  );
}

export function openAppleToken(sealed: string) {
  const value = JSON.parse(decryptSecret(sealed)) as {
    client_id?: unknown;
    refresh_token?: unknown;
  };
  if (
    typeof value.client_id !== "string" ||
    typeof value.refresh_token !== "string"
  ) {
    throw new Error("Unreadable Apple token");
  }
  return { clientId: value.client_id, refreshToken: value.refresh_token };
}

export async function revokeAppleToken(
  config: AppleSignInConfig,
  token: { clientId: string; refreshToken: string },
) {
  const response = await fetch(`${config.authUrl}/auth/revoke`, {
    body: new URLSearchParams({
      client_id: token.clientId,
      client_secret: await appleClientSecret(config, token.clientId),
      token: token.refreshToken,
      token_type_hint: "refresh_token",
    }),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    method: "POST",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new AppleSignInError(`Apple token revoke failed: ${response.status}`);
  }
}

// Before an account is deleted: every Apple token it holds is revoked, so
// the person's Apple ID no longer lists FrameOS as signed in. Never throws:
// a failed revoke must not keep an account the person asked to delete (it
// is logged, and the person can still remove FrameOS under their Apple ID's
// "Sign in with Apple" settings).
export async function revokeAccountAppleTokens(
  db: ReturnType<typeof createDb>,
  accountId: string,
) {
  const rows = (await accountProviderTokens(db, accountId)).filter(
    (row) => row.providerKey === appleProviderKey && row.providerTokenEncrypted,
  );
  if (rows.length === 0) {
    return { revoked: 0 };
  }
  const config = getAppleSignInConfig();
  if (!config) {
    reportError(
      "auth.apple_revoke_unconfigured",
      new Error("Apple tokens to revoke, but Sign in with Apple is not configured"),
      { accountId },
    );
    return { revoked: 0 };
  }
  let revoked = 0;
  for (const row of rows) {
    try {
      await revokeAppleToken(config, openAppleToken(row.providerTokenEncrypted!));
      revoked += 1;
    } catch (error) {
      reportError("auth.apple_revoke_failed", error, { accountId });
    }
  }
  return { revoked };
}

// The web round trip's own cookie. Apple answers with a cross-site form
// POST, which carries no SameSite=Lax cookie, so the state, the nonce and
// where to go next ride one signed cookie that is SameSite=None (Secure, so
// production only; a local server over http keeps Lax and cannot finish a
// real Apple round trip anyway: Apple calls back to https URLs only). Scoped
// to the callback's path, so no other request carries it.
export const appleFlowCookieName = "frameos_apple_flow";
export const appleFlowMaxAgeSeconds = 10 * 60;

export type AppleFlow = {
  nonce: string;
  returnTo?: string | undefined;
  state: string;
};

function flowKey() {
  return derivedSigningKey("apple-sign-in-flow");
}

export async function createAppleFlowToken(flow: AppleFlow) {
  return new SignJWT({ flow, purpose: "apple-flow" })
    .setProtectedHeader({ alg: "HS256" })
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime(`${appleFlowMaxAgeSeconds}s`)
    .sign(flowKey());
}

export async function readAppleFlowToken(
  token: string | undefined,
): Promise<AppleFlow | undefined> {
  if (!token) {
    return undefined;
  }
  try {
    const { payload } = await jwtVerify(token, flowKey(), { algorithms: ["HS256"] });
    const flow = payload.flow as AppleFlow | undefined;
    if (
      payload.purpose !== "apple-flow" ||
      !flow ||
      typeof flow.state !== "string" ||
      typeof flow.nonce !== "string"
    ) {
      return undefined;
    }
    return flow;
  } catch {
    return undefined;
  }
}

export function appleFlowCookieOptions() {
  const production = process.env.NODE_ENV === "production";
  return {
    httpOnly: true,
    maxAge: appleFlowMaxAgeSeconds,
    path: "/api/auth/apple",
    sameSite: production ? ("none" as const) : ("lax" as const),
    secure: production,
  };
}

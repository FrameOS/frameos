import { jwtVerify, SignJWT, type JWTPayload } from "jose";
import { derivedSigningKey } from "./keys";
import type { SessionProfile } from "./session";

const loginRequestType = "frameos_login_request";

export const loginCodeExpiresInSeconds = 2 * 60;

export type FrameosLoginRequest = {
  intent: "login" | "signup";
  linkedClientId: string;
  redirectTo?: string | undefined;
  redirectUri: string;
  state: string;
};

// Profile claims released to the linked client when it redeems a login code.
// These are stored server-side (frameos_login_codes.profile); the code that
// travels through the redirect URL is an opaque random token with no PII.
export type FrameosLoginCodeProfile = Required<
  Pick<SessionProfile, "accountId" | "providerIssuer" | "providerSubject">
> &
  Pick<SessionProfile, "email" | "emailVerified" | "name">;

function secretKey() {
  return derivedSigningKey("frameos-login-request");
}

export function safeFrameosRedirectUri(value: unknown) {
  if (typeof value !== "string") {
    return undefined;
  }

  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return undefined;
    }
    if (url.username || url.password) {
      return undefined;
    }
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

export async function createFrameosLoginRequestToken(
  request: FrameosLoginRequest,
) {
  const payload: JWTPayload & Record<string, unknown> = {
    frameos_type: loginRequestType,
    intent: request.intent,
    linked_client_id: request.linkedClientId,
    redirect_uri: request.redirectUri,
    state: request.state,
  };
  if (request.redirectTo) {
    payload.redirect_to = request.redirectTo;
  }

  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(secretKey());
}

export async function verifyFrameosLoginRequestToken(token: string) {
  try {
    const verified = await jwtVerify(token, secretKey());
    const payload = verified.payload;
    if (payload.frameos_type !== loginRequestType) {
      return undefined;
    }

    const linkedClientId = stringClaim(payload, "linked_client_id");
    const redirectUri = safeFrameosRedirectUri(payload.redirect_uri);
    const state = stringClaim(payload, "state");
    if (!linkedClientId || !redirectUri || !state) {
      return undefined;
    }

    const intent = payload.intent === "signup" ? "signup" : "login";
    const redirectTo = stringClaim(payload, "redirect_to");
    return {
      intent,
      linkedClientId,
      redirectTo,
      redirectUri,
      state,
    } satisfies FrameosLoginRequest;
  } catch {
    return undefined;
  }
}

// Validates the profile jsonb read back from frameos_login_codes. The row is
// written by our own authorize route, but parse defensively anyway.
export function parseFrameosLoginCodeProfile(
  value: unknown,
): FrameosLoginCodeProfile | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const accountId = stringField(record, "accountId");
  const providerIssuer = stringField(record, "providerIssuer");
  const providerSubject = stringField(record, "providerSubject");
  if (!accountId || !providerIssuer || !providerSubject) {
    return undefined;
  }

  return {
    accountId,
    email: stringField(record, "email"),
    emailVerified: record.emailVerified === true,
    name: stringField(record, "name"),
    providerIssuer,
    providerSubject,
  };
}

function stringClaim(payload: JWTPayload, key: string) {
  const value = payload[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function stringField(record: Record<string, unknown>, key: string) {
  const value = record[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

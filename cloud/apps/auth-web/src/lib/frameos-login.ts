import { jwtVerify, SignJWT, type JWTPayload } from "jose";
import { derivedSigningKey } from "./keys";

const loginRequestType = "frameos_login_request";

export const loginCodeExpiresInSeconds = 2 * 60;

// Both ride inside the signed request JWT and come back out of it verbatim,
// so they are bounded here rather than growing the token without limit.
export const maxLoginStateChars = 512;
export const maxLoginRedirectToChars = 2048;

export type FrameosLoginRequest = {
  intent: "login" | "signup";
  linkedClientId: string;
  redirectTo?: string | undefined;
  redirectUri: string;
  state: string;
};

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

// Where the backend sends the browser after its own callback: a path on the
// backend itself, never a full URL — the linked backend's origin is already
// pinned by redirect_uri, and a URL here would be an open redirect through
// the handoff. `undefined` when absent, `null` when present but unusable.
export function safeFrameosRedirectTo(value: unknown): string | null | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "string" || value.length > maxLoginRedirectToChars) {
    return null;
  }
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) {
    return null;
  }
  if (hasControlCharacter(value)) {
    return null;
  }
  return value;
}

// Anything below space plus DEL. Spelled out rather than as a regex class
// because eslint's no-control-regex refuses the character range.
function hasControlCharacter(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
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

function stringClaim(payload: JWTPayload, key: string) {
  const value = payload[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}


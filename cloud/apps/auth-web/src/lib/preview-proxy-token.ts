import { jwtVerify, SignJWT } from "jose";
import { derivedSigningKey } from "./keys";

// Short-lived tokens for the store's preview proxy (/api/store/preview-proxy).
// The wasm preview worker reaches the proxy from inside the browser; the
// proxy used to accept it on the same-origin check alone, which a worker
// moved to an opaque origin (docs/security-todo.md, "Preview worker
// isolation") cannot pass: its Origin is `null`. The page mints a token here
// instead (POST /api/store/preview-proxy/token, same-origin and rate
// limited), hands it to the worker, and the worker sends it in a header.
//
// The proxy is anonymous (store previews have no account), so a token names
// no one: it says this deployment handed it out a moment ago, under the mint
// route's rate limit. Signed with a key derived for this purpose alone, so it
// never verifies as a session or any other token.

export const previewProxyTokenHeader = "x-frameos-preview-token";
// Long enough for a preview between two refreshes (the page mints a new one
// well before this runs out), short enough not to be a standing credential.
export const previewProxyTokenTtlSeconds = 15 * 60;

const tokenType = "frameos_preview_proxy";

function secretKey() {
  return derivedSigningKey("preview-proxy-token");
}

export async function createPreviewProxyToken(now = Date.now()) {
  const issuedAt = Math.floor(now / 1000);
  const expiresAt = issuedAt + previewProxyTokenTtlSeconds;
  const token = await new SignJWT({ frameos_type: tokenType })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAt)
    .sign(secretKey());
  return {
    expiresAt: new Date(expiresAt * 1000).toISOString(),
    expiresIn: previewProxyTokenTtlSeconds,
    token,
  };
}

export async function previewProxyTokenValid(
  token: string | null | undefined,
  now = Date.now(),
) {
  if (!token) {
    return false;
  }
  try {
    const { payload } = await jwtVerify(token, secretKey(), {
      algorithms: ["HS256"],
      currentDate: new Date(now),
    });
    // A token that claims to live longer than any we mint is not ours.
    return (
      payload.frameos_type === tokenType &&
      typeof payload.exp === "number" &&
      typeof payload.iat === "number" &&
      payload.exp - payload.iat <= previewProxyTokenTtlSeconds
    );
  } catch {
    return false;
  }
}

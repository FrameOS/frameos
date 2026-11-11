import { SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appSignInCallbackUrl,
  createAppSignInCode,
  createAppSignInRequestToken,
  pkceChallenge,
  pkceMatches,
  validChallenge,
  validState,
  verifyAppSignInCode,
  verifyAppSignInRequestToken,
} from "./app-sign-in";
import { derivedSigningKey } from "./keys";

// RFC 7636, appendix B.
const rfcVerifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const rfcChallenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

describe("PKCE", () => {
  it("is S256, base64url, as RFC 7636 computes it", () => {
    expect(pkceChallenge(rfcVerifier)).toBe(rfcChallenge);
    expect(pkceMatches(rfcVerifier, rfcChallenge)).toBe(true);
  });

  it("refuses a verifier that is the wrong one or not a verifier", () => {
    expect(pkceMatches(`${rfcVerifier.slice(0, -1)}x`, rfcChallenge)).toBe(false);
    expect(pkceMatches(rfcChallenge, rfcChallenge)).toBe(false);
    expect(pkceMatches("short", pkceChallenge("short"))).toBe(false);
    expect(pkceMatches(undefined, rfcChallenge)).toBe(false);
    expect(pkceMatches(`${"a".repeat(129)}`, pkceChallenge("a".repeat(129)))).toBe(false);
  });

  it("takes only a 43-character base64url challenge", () => {
    expect(validChallenge(rfcChallenge)).toBe(true);
    expect(validChallenge(`${rfcChallenge}=`)).toBe(false);
    expect(validChallenge(rfcChallenge.slice(1))).toBe(false);
    expect(validChallenge("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw+cM")).toBe(false);
    expect(validChallenge(null)).toBe(false);
  });
});

describe("state", () => {
  it("is printable, bounded and present", () => {
    expect(validState("abc-123_XYZ")).toBe(true);
    expect(validState("")).toBe(false);
    expect(validState("a b")).toBe(false);
    expect(validState("a\r\nb")).toBe(false);
    expect(validState("a".repeat(512))).toBe(true);
    expect(validState("a".repeat(513))).toBe(false);
    expect(validState(undefined)).toBe(false);
  });
});

describe("the callback", () => {
  it("is frameos://sign-in and nothing else", () => {
    const url = new URL(appSignInCallbackUrl({ code: "c&d", state: "s" }));
    expect(`${url.protocol}//${url.host}`).toBe("frameos://sign-in");
    expect(url.searchParams.get("code")).toBe("c&d");
    expect(url.searchParams.get("state")).toBe("s");
  });
});

describe("tokens", () => {
  const originalSecret = process.env.SESSION_SECRET;
  beforeEach(() => {
    process.env.SESSION_SECRET = "app-sign-in-test-secret";
  });
  afterEach(() => {
    if (originalSecret === undefined) {
      delete process.env.SESSION_SECRET;
    } else {
      process.env.SESSION_SECRET = originalSecret;
    }
  });

  it("reads a request back, with when it was made", async () => {
    const before = Math.floor(Date.now() / 1000);
    const token = await createAppSignInRequestToken({
      challenge: rfcChallenge,
      provider: "google",
      reauth: true,
      state: "state-1",
    });
    const request = await verifyAppSignInRequestToken(token);
    expect(request).toMatchObject({
      challenge: rfcChallenge,
      provider: "google",
      reauth: true,
      state: "state-1",
    });
    expect(request?.issuedAt).toBeGreaterThanOrEqual(before);
  });

  it("reads a code back", async () => {
    const authenticatedAt = new Date("2026-11-11T10:00:00Z");
    const code = await createAppSignInCode({
      accountId: "account-1",
      authenticatedAt,
      challenge: rfcChallenge,
      identityId: "identity-1",
    });
    const read = await verifyAppSignInCode(code);
    expect(read).toMatchObject({
      accountId: "account-1",
      challenge: rfcChallenge,
      identityId: "identity-1",
    });
    expect(read?.authenticatedAt.getTime()).toBe(authenticatedAt.getTime());
    expect(read?.codeId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("never takes a request for a code or a code for a request", async () => {
    const request = await createAppSignInRequestToken({
      challenge: rfcChallenge,
      reauth: false,
      state: "s",
    });
    const code = await createAppSignInCode({
      accountId: "a",
      authenticatedAt: new Date(),
      challenge: rfcChallenge,
      identityId: "i",
    });
    expect(await verifyAppSignInCode(request)).toBeUndefined();
    expect(await verifyAppSignInRequestToken(code)).toBeUndefined();
  });

  it("refuses an expired code", async () => {
    const expired = await new SignJWT({
      account_id: "a",
      authenticated_at: Date.now(),
      challenge: rfcChallenge,
      frameos_type: "app_sign_in_code",
      identity_id: "i",
    })
      .setProtectedHeader({ alg: "HS256" })
      .setJti("11111111-1111-4111-8111-111111111111")
      .setIssuedAt(Math.floor(Date.now() / 1000) - 600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(derivedSigningKey("app-sign-in-code"));
    expect(await verifyAppSignInCode(expired)).toBeUndefined();
  });

  it("refuses one signed under another purpose's key", async () => {
    const forged = await new SignJWT({
      challenge: rfcChallenge,
      frameos_type: "app_sign_in_request",
      reauth: false,
      state: "s",
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("10m")
      .sign(derivedSigningKey("frameos-login-request"));
    expect(await verifyAppSignInRequestToken(forged)).toBeUndefined();
  });
});

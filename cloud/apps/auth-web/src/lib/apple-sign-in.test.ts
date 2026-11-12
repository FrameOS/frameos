import { decodeJwt, decodeProtectedHeader, exportPKCS8, generateKeyPair } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appleAuthorizationUrl,
  appleClientSecret,
  appleDisplayName,
  appleDisplayNameFromUserField,
  appleFlowCookieOptions,
  appleNonceHash,
  validAppleNonce,
} from "./apple-sign-in";
import type { AppleSignInConfig } from "./env";

async function config(): Promise<AppleSignInConfig & { servicesId: string }> {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  return {
    appBundleId: "net.frameos.app",
    authUrl: "https://appleid.apple.com",
    keyId: "KEYID56789",
    privateKey: await exportPKCS8(privateKey),
    servicesId: "net.frameos.cloud",
    teamId: "TEAMID1234",
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Sign in with Apple helpers", () => {
  it("signs a five-minute client secret the way Apple asks", async () => {
    const now = new Date("2026-11-11T12:00:00Z");
    const secret = await appleClientSecret(await config(), "net.frameos.app", now);
    expect(decodeProtectedHeader(secret)).toEqual({ alg: "ES256", kid: "KEYID56789" });
    expect(decodeJwt(secret)).toEqual({
      aud: "https://appleid.apple.com",
      exp: now.getTime() / 1000 + 300,
      iat: now.getTime() / 1000,
      iss: "TEAMID1234",
      sub: "net.frameos.app",
    });
  });

  it("asks Apple for a form POST with the name and email", async () => {
    const url = appleAuthorizationUrl(await config(), { nonce: "n", state: "s" });
    expect(url.origin + url.pathname).toBe("https://appleid.apple.com/auth/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "net.frameos.cloud",
      nonce: "n",
      redirect_uri: "http://localhost:3000/api/auth/apple/callback",
      response_mode: "form_post",
      response_type: "code",
      scope: "name email",
      state: "s",
    });
  });

  it("hashes the app's nonce as the app does (SHA-256, hex)", () => {
    expect(appleNonceHash("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(validAppleNonce("a-nonce-the-app-made-0123456789")).toBe(true);
    expect(validAppleNonce("short")).toBe(false);
    expect(validAppleNonce("has spaces in it, 0123456789")).toBe(false);
    expect(validAppleNonce(42)).toBe(false);
  });

  it("reads the name Apple gives once, and nothing else", () => {
    expect(appleDisplayName(" Jo ", "Appleseed")).toBe("Jo Appleseed");
    expect(appleDisplayName("Jo", undefined)).toBe("Jo");
    expect(appleDisplayName("", null)).toBeUndefined();
    expect(appleDisplayName({}, 3)).toBeUndefined();
    expect(appleDisplayName("x".repeat(80), "y".repeat(80))).toHaveLength(100);
    expect(
      appleDisplayNameFromUserField(
        JSON.stringify({ email: "a@b.c", name: { firstName: "Jo", lastName: "Appleseed" } }),
      ),
    ).toBe("Jo Appleseed");
    expect(appleDisplayNameFromUserField("{not json")).toBeUndefined();
    expect(appleDisplayNameFromUserField(undefined)).toBeUndefined();
  });

  it("keeps the flow cookie to the callback, cross-site only in production", () => {
    expect(appleFlowCookieOptions()).toMatchObject({
      httpOnly: true,
      path: "/api/auth/apple",
      sameSite: "lax",
      secure: false,
    });
    vi.stubEnv("NODE_ENV", "production");
    expect(appleFlowCookieOptions()).toMatchObject({ sameSite: "none", secure: true });
  });
});

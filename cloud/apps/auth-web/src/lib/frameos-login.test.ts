import { SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createFrameosLoginRequestToken,
  maxLoginRedirectToChars,
  safeFrameosRedirectTo,
  safeFrameosRedirectUri,
  verifyFrameosLoginRequestToken,
} from "./frameos-login";
import { derivedSigningKey } from "./keys";

describe("safeFrameosRedirectTo", () => {
  it("is absent for nothing, unusable for anything but a relative path", () => {
    expect(safeFrameosRedirectTo(undefined)).toBeUndefined();
    expect(safeFrameosRedirectTo("")).toBeUndefined();
    expect(safeFrameosRedirectTo(null)).toBeUndefined();
    expect(safeFrameosRedirectTo("/frames/1?x=y#top")).toBe("/frames/1?x=y#top");
    expect(safeFrameosRedirectTo("frames/1")).toBeNull();
    expect(safeFrameosRedirectTo("https://evil.example/")).toBeNull();
    expect(safeFrameosRedirectTo("//evil.example/")).toBeNull();
    expect(safeFrameosRedirectTo("/\\evil.example/")).toBeNull();
    expect(safeFrameosRedirectTo("javascript:alert(1)")).toBeNull();
    expect(safeFrameosRedirectTo("/ok\r\nSet-Cookie: x")).toBeNull();
    expect(safeFrameosRedirectTo(42)).toBeNull();
  });

  it("caps the length", () => {
    expect(safeFrameosRedirectTo(`/${"a".repeat(maxLoginRedirectToChars - 1)}`)).not.toBeNull();
    expect(safeFrameosRedirectTo(`/${"a".repeat(maxLoginRedirectToChars)}`)).toBeNull();
  });
});

describe("safeFrameosRedirectUri", () => {
  it("keeps http(s) URLs without credentials and drops the fragment", () => {
    expect(safeFrameosRedirectUri("http://10.1.1.2:8989/cb#frag")).toBe(
      "http://10.1.1.2:8989/cb",
    );
    expect(safeFrameosRedirectUri("ftp://10.1.1.2/cb")).toBeUndefined();
    expect(safeFrameosRedirectUri("http://user:pw@10.1.1.2/cb")).toBeUndefined();
    expect(safeFrameosRedirectUri("not a url")).toBeUndefined();
  });
});

describe("verifyFrameosLoginRequestToken", () => {
  const originalSecret = process.env.SESSION_SECRET;
  beforeEach(() => {
    process.env.SESSION_SECRET = "frameos-login-test-secret";
  });
  afterEach(() => {
    if (originalSecret === undefined) {
      delete process.env.SESSION_SECRET;
    } else {
      process.env.SESSION_SECRET = originalSecret;
    }
  });

  const request = {
    intent: "login" as const,
    linkedClientId: "client-1",
    redirectUri: "http://10.1.1.2:8989/cb",
    state: "state-1",
  };

  it("reads back what it signed", async () => {
    const token = await createFrameosLoginRequestToken(request);
    expect(await verifyFrameosLoginRequestToken(token)).toMatchObject(request);
  });

  it("accepts HS256 only, even under the right key", async () => {
    const token = await new SignJWT({
      frameos_type: "frameos_login_request",
      intent: request.intent,
      linked_client_id: request.linkedClientId,
      redirect_uri: request.redirectUri,
      state: request.state,
    })
      .setProtectedHeader({ alg: "HS512" })
      .setIssuedAt()
      .setExpirationTime("10m")
      .sign(derivedSigningKey("frameos-login-request"));
    expect(await verifyFrameosLoginRequestToken(token)).toBeUndefined();
  });
});

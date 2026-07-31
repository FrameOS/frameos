import { describe, expect, it } from "vitest";
import {
  buildAuthorizationUrl,
  createPkcePair,
  normalizeFrameosAuthProviderUrl,
  pollDeviceAuthorization,
  startDeviceAuthorization,
} from "./index";

describe("auth-client", () => {
  it("builds an authorization URL with PKCE and extra parameters", async () => {
    const pkce = await createPkcePair();
    const url = buildAuthorizationUrl(
      {
        authorization_endpoint: "https://auth.example.test/oauth/v2/authorize",
        issuer: "https://auth.example.test",
        jwks_uri: "https://auth.example.test/oauth/v2/keys",
        token_endpoint: "https://auth.example.test/oauth/v2/token",
      },
      {
        clientId: "client-id",
        codeChallenge: pkce.challenge,
        extraParams: { direct_sign_in: "social:google" },
        nonce: "nonce",
        redirectUri: "http://localhost:3000/api/auth/callback",
        scopes: ["openid", "email"],
        state: "state",
      },
    );

    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("direct_sign_in")).toBe("social:google");
    expect(url.searchParams.get("scope")).toBe("openid email");
  });

  it("normalizes the FrameOS auth provider URL default, override, and disabled states", () => {
    expect(normalizeFrameosAuthProviderUrl(undefined)).toEqual({
      disabled: false,
      providerUrl: "https://cloud.frameos.net",
    });
    expect(normalizeFrameosAuthProviderUrl(" disabled ")).toEqual({
      disabled: true,
    });
    expect(
      normalizeFrameosAuthProviderUrl("https://auth.example.test/"),
    ).toEqual({
      disabled: false,
      providerUrl: "https://auth.example.test",
    });
  });

  it("starts and polls the FrameOS Cloud device authorization contract", async () => {
    const calls: { body?: string | null | undefined; url: string }[] = [];
    const fetchImpl = async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = input.toString();
      calls.push({ body: init?.body?.toString(), url });

      if (url.endsWith("/api/device/start")) {
        return Response.json({
          device_code: "device-code",
          expires_in: 600,
          interval: 5,
          user_code: "ABCD-EFGH",
          verification_uri: "https://auth.example.test/device",
          verification_uri_complete:
            "https://auth.example.test/device?user_code=ABCD-EFGH",
        });
      }

      return Response.json({ error: "authorization_pending" });
    };

    const started = await startDeviceAuthorization(
      "https://auth.example.test",
      {
        public_display_name: "Kitchen frame backend",
        reported_frameos_version: "0.1.0",
      },
      { fetchImpl },
    );
    const polled = await pollDeviceAuthorization(
      "https://auth.example.test",
      started.device_code,
      { fetchImpl },
    );

    expect(started.user_code).toBe("ABCD-EFGH");
    expect(polled).toEqual({ error: "authorization_pending" });
    expect(calls.map((call) => call.url)).toEqual([
      "https://auth.example.test/api/device/start",
      "https://auth.example.test/api/device/poll",
    ]);
  });

  it("maps rate-limited poll responses to slow_down with the retry-after interval", async () => {
    const fetchImpl = async () =>
      Response.json({ error: "rate_limited", retry_after: 30 }, { status: 429 });

    const polled = await pollDeviceAuthorization(
      "https://auth.example.test",
      "device-code",
      { fetchImpl },
    );

    expect(polled).toEqual({ error: "slow_down", interval: 30 });
  });

  it("passes through terminal poll errors", async () => {
    const fetchImpl = async () =>
      Response.json({ error: "access_denied" }, { status: 403 });

    const polled = await pollDeviceAuthorization(
      "https://auth.example.test",
      "device-code",
      { fetchImpl },
    );

    expect(polled).toEqual({ error: "access_denied" });
  });

  it("forwards an abort signal to fetch so callers can enforce timeouts", async () => {
    const seenSignals: (AbortSignal | null | undefined)[] = [];
    const fetchImpl = async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      seenSignals.push(init?.signal);
      return Response.json({ error: "authorization_pending" });
    };

    const controller = new AbortController();
    await pollDeviceAuthorization("https://auth.example.test", "device-code", {
      fetchImpl,
      signal: controller.signal,
    });

    expect(seenSignals).toEqual([controller.signal]);
  });

  it("rejects when polling with an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      pollDeviceAuthorization("https://auth.example.test", "device-code", {
        signal: controller.signal,
      }),
    ).rejects.toThrow();
  });

  it("throws on unexpected or unparseable poll responses", async () => {
    const htmlError = async () =>
      new Response("<html>Internal Server Error</html>", { status: 500 });
    await expect(
      pollDeviceAuthorization("https://auth.example.test", "device-code", {
        fetchImpl: htmlError,
      }),
    ).rejects.toThrow("poll failed: 500");

    const unknownError = async () =>
      Response.json({ error: "database_not_configured" }, { status: 503 });
    await expect(
      pollDeviceAuthorization("https://auth.example.test", "device-code", {
        fetchImpl: unknownError,
      }),
    ).rejects.toThrow("poll failed: 503");
  });
});

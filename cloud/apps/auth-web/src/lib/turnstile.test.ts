import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getTurnstileSiteKey,
  isTurnstileConfigured,
  verifyTurnstileToken,
} from "./turnstile";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  delete process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
  delete process.env.TURNSTILE_SECRET_KEY;
});

describe("turnstile configuration", () => {
  it("is not configured with only one half of the key pair", () => {
    process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = "site";
    // A site key without a secret renders a widget whose answer is never
    // checked — protection theatre, and worse than none.
    expect(isTurnstileConfigured()).toBe(false);

    delete process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
    process.env.TURNSTILE_SECRET_KEY = "secret";
    expect(isTurnstileConfigured()).toBe(false);
  });

  it("hides the widget when no site key is set", () => {
    expect(getTurnstileSiteKey()).toBeUndefined();
  });
});

describe("verifyTurnstileToken", () => {
  it("passes everything through when no secret is configured", async () => {
    // Local development and the integration tests must not need a Cloudflare
    // account to sign up.
    await expect(verifyTurnstileToken(undefined)).resolves.toEqual({ ok: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a missing token without calling Cloudflare", async () => {
    process.env.TURNSTILE_SECRET_KEY = "secret";

    await expect(verifyTurnstileToken(undefined)).resolves.toEqual({
      errorCodes: ["missing-input-response"],
      ok: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts a token Cloudflare confirms", async () => {
    process.env.TURNSTILE_SECRET_KEY = "secret";
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true }), { status: 200 }),
    );

    await expect(verifyTurnstileToken("tok", "203.0.113.7")).resolves.toEqual({
      ok: true,
    });

    const body = fetchMock.mock.calls[0]?.[1]?.body as URLSearchParams;
    expect(body.get("response")).toBe("tok");
    expect(body.get("remoteip")).toBe("203.0.113.7");
  });

  it("surfaces Cloudflare's rejection codes", async () => {
    process.env.TURNSTILE_SECRET_KEY = "secret";
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ "error-codes": ["timeout-or-duplicate"], success: false }),
        { status: 200 },
      ),
    );

    await expect(verifyTurnstileToken("tok")).resolves.toEqual({
      errorCodes: ["timeout-or-duplicate"],
      ok: false,
    });
  });

  it("does not send the rate limiter's 'local' placeholder as an IP", async () => {
    process.env.TURNSTILE_SECRET_KEY = "secret";
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true }), { status: 200 }),
    );

    await verifyTurnstileToken("tok", "local");

    const body = fetchMock.mock.calls[0]?.[1]?.body as URLSearchParams;
    expect(body.has("remoteip")).toBe(false);
  });

  it("fails CLOSED when Cloudflare is unreachable", async () => {
    // The tempting alternative — let signups through during a Cloudflare
    // outage — turns that outage into an open, unprotected signup endpoint,
    // which is exactly when a flood is cheapest to run. A brief inability to
    // sign up is the better failure, so this must never return ok.
    process.env.TURNSTILE_SECRET_KEY = "secret";
    vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockRejectedValueOnce(new Error("network down"));

    await expect(verifyTurnstileToken("tok")).resolves.toEqual({
      errorCodes: ["verification-unavailable"],
      ok: false,
    });
  });

  it("fails closed on a non-2xx from the siteverify endpoint too", async () => {
    process.env.TURNSTILE_SECRET_KEY = "secret";
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 502 }));

    await expect(verifyTurnstileToken("tok")).resolves.toEqual({
      errorCodes: ["http-502"],
      ok: false,
    });
  });
});

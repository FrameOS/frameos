import { afterEach, describe, expect, it } from "vitest";
import type { NextRequest } from "next/server";
import {
  checkRateLimit,
  claimSingleUse,
  clientKey,
  resetRateLimitForTests,
  singleUseClaimed,
} from "./rate-limit";

afterEach(() => {
  resetRateLimitForTests();
  delete process.env.RATE_LIMIT_TRUSTED_PROXY_COUNT;
});

function requestWithHeaders(headers: Record<string, string>) {
  return { headers: new Headers(headers) } as unknown as NextRequest;
}

describe("rate limit", () => {
  it("allows requests until the bucket limit is reached", async () => {
    expect((await checkRateLimit("device:start:local", { limit: 2, now: 100, windowMs: 1000 })).allowed)
      .toBe(true);
    expect((await checkRateLimit("device:start:local", { limit: 2, now: 200, windowMs: 1000 })).allowed)
      .toBe(true);
    expect((await checkRateLimit("device:start:local", { limit: 2, now: 300, windowMs: 1000 })).allowed)
      .toBe(false);
  });

  it("resets a bucket after the window", async () => {
    expect((await checkRateLimit("device:poll:local", { limit: 1, now: 100, windowMs: 1000 })).allowed)
      .toBe(true);
    expect((await checkRateLimit("device:poll:local", { limit: 1, now: 1200, windowMs: 1000 })).allowed)
      .toBe(true);
  });
});

describe("single-use claims", () => {
  it("lets the first claim through and refuses every later one", async () => {
    expect(await singleUseClaimed("token-1")).toBe(false);
    expect(await claimSingleUse("token-1", 60_000)).toBe(true);
    expect(await singleUseClaimed("token-1")).toBe(true);
    expect(await claimSingleUse("token-1", 60_000)).toBe(false);
    // Peeking never spends a fresh key.
    expect(await singleUseClaimed("token-2")).toBe(false);
    expect(await claimSingleUse("token-2", 60_000)).toBe(true);
  });
});

describe("clientKey", () => {
  it("uses the proxy-appended IP, ignoring client-spoofed XFF entries", () => {
    // With one trusted proxy, the real client IP is the last XFF entry; a client
    // prepending a fake IP cannot move the key.
    process.env.RATE_LIMIT_TRUSTED_PROXY_COUNT = "1";
    const request = requestWithHeaders({
      "x-forwarded-for": "1.1.1.1, 203.0.113.7",
    });
    expect(clientKey(request)).toBe("203.0.113.7");
  });

  it("walks back the configured number of trusted proxies", () => {
    process.env.RATE_LIMIT_TRUSTED_PROXY_COUNT = "2";
    const request = requestWithHeaders({
      "x-forwarded-for": "9.9.9.9, 203.0.113.7, 10.0.0.1",
    });
    expect(clientKey(request)).toBe("203.0.113.7");
  });

  it("refuses a chain shorter than the trusted proxy count", () => {
    // Two proxies each append an entry; a one-entry chain means the request
    // came in around the outer proxy and the entry is the client's own word.
    process.env.RATE_LIMIT_TRUSTED_PROXY_COUNT = "2";
    expect(
      clientKey(requestWithHeaders({ "x-forwarded-for": "203.0.113.7" })),
    ).toBe("untrusted");
    expect(
      clientKey(
        requestWithHeaders({
          "x-forwarded-for": "203.0.113.7",
          "x-real-ip": "203.0.113.7",
        }),
      ),
    ).toBe("untrusted");
    // Exactly as many entries as proxies is the shortest honest chain.
    expect(
      clientKey(requestWithHeaders({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" })),
    ).toBe("203.0.113.7");
  });

  it("falls back to x-real-ip then a constant when no chain is present", () => {
    process.env.RATE_LIMIT_TRUSTED_PROXY_COUNT = "1";
    expect(clientKey(requestWithHeaders({ "x-real-ip": "198.51.100.9" }))).toBe(
      "198.51.100.9",
    );
    expect(clientKey(requestWithHeaders({}))).toBe("local");
  });
});

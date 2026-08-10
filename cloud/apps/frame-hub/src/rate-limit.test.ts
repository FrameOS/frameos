import type { IncomingMessage } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkMemoryRateLimit,
  clientIpFromRequest,
  resetRateLimitsForTests,
} from "./rate-limit";

beforeEach(() => resetRateLimitsForTests());

describe("checkMemoryRateLimit", () => {
  const options = { limit: 3, windowMs: 1000 };

  it("allows up to the limit inside one window, then denies", () => {
    const now = 1_000_000;
    for (let i = 0; i < 3; i += 1) {
      expect(checkMemoryRateLimit("k", options, now).allowed).toBe(true);
    }
    const denied = checkMemoryRateLimit("k", options, now);
    expect(denied.allowed).toBe(false);
    expect(denied.resetAt).toBe(now + 1000);
  });

  it("does not let denied attempts extend the window", () => {
    const now = 1_000_000;
    for (let i = 0; i < 10; i += 1) {
      checkMemoryRateLimit("k", options, now + i);
    }
    // Fresh window once reset_at passes.
    expect(checkMemoryRateLimit("k", options, now + 1001).allowed).toBe(true);
  });

  it("keys buckets independently", () => {
    const now = 1_000_000;
    for (let i = 0; i < 3; i += 1) {
      checkMemoryRateLimit("a", options, now);
    }
    expect(checkMemoryRateLimit("a", options, now).allowed).toBe(false);
    expect(checkMemoryRateLimit("b", options, now).allowed).toBe(true);
  });
});

describe("clientIpFromRequest", () => {
  const original = process.env.RATE_LIMIT_TRUSTED_PROXY_COUNT;
  afterEach(() => {
    if (original === undefined) {
      delete process.env.RATE_LIMIT_TRUSTED_PROXY_COUNT;
    } else {
      process.env.RATE_LIMIT_TRUSTED_PROXY_COUNT = original;
    }
  });

  const request = (headers: Record<string, string>, remote = "10.0.0.1") =>
    ({ headers, socket: { remoteAddress: remote } }) as unknown as IncomingMessage;

  it("takes the entry the closest trusted proxy appended", () => {
    delete process.env.RATE_LIMIT_TRUSTED_PROXY_COUNT;
    expect(
      clientIpFromRequest(
        request({ "x-forwarded-for": "1.1.1.1, 2.2.2.2, 3.3.3.3" }),
      ),
    ).toBe("3.3.3.3");
    process.env.RATE_LIMIT_TRUSTED_PROXY_COUNT = "2";
    expect(
      clientIpFromRequest(
        request({ "x-forwarded-for": "1.1.1.1, 2.2.2.2, 3.3.3.3" }),
      ),
    ).toBe("2.2.2.2");
  });

  it("ignores a client-supplied chain when no proxy is trusted", () => {
    process.env.RATE_LIMIT_TRUSTED_PROXY_COUNT = "0";
    expect(
      clientIpFromRequest(request({ "x-forwarded-for": "1.1.1.1" })),
    ).toBe("10.0.0.1");
  });

  it("falls back to x-real-ip and then the socket address", () => {
    delete process.env.RATE_LIMIT_TRUSTED_PROXY_COUNT;
    expect(clientIpFromRequest(request({ "x-real-ip": " 4.4.4.4 " }))).toBe(
      "4.4.4.4",
    );
    expect(clientIpFromRequest(request({}))).toBe("10.0.0.1");
    expect(clientIpFromRequest(request({}, ""))).toBe("local");
  });
});

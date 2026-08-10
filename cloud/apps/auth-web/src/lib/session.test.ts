import { afterEach, describe, expect, it } from "vitest";
import {
  sessionAbsoluteMaxAgeSeconds,
  sessionCookieOptions,
  sessionIdleMaxAgeSeconds,
  sessionRefreshIntervalSeconds,
} from "./session";
import { sessionCookieMaxAgeSeconds } from "./session-refresh";

const originalCloudUrl = process.env.FRAMEOS_CLOUD_APP_URL;
const originalAccountUrl = process.env.FRAMEOS_ACCOUNT_APP_URL;
const originalScenesUrl = process.env.FRAMEOS_SCENES_APP_URL;
const originalCookieDomain = process.env.FRAMEOS_SESSION_COOKIE_DOMAIN;

function restore(key: string, value: string | undefined) {
  if (value) {
    process.env[key] = value;
  } else {
    delete process.env[key];
  }
}

afterEach(() => {
  restore("FRAMEOS_CLOUD_APP_URL", originalCloudUrl);
  restore("FRAMEOS_ACCOUNT_APP_URL", originalAccountUrl);
  restore("FRAMEOS_SCENES_APP_URL", originalScenesUrl);
  restore("FRAMEOS_SESSION_COOKIE_DOMAIN", originalCookieDomain);
});

describe("sessionCookieOptions", () => {
  it("scopes the session to the configured parent domain in split mode", () => {
    process.env.FRAMEOS_CLOUD_APP_URL = "https://cloud.frameos.net";
    process.env.FRAMEOS_ACCOUNT_APP_URL = "https://account.frameos.net";
    process.env.FRAMEOS_SCENES_APP_URL = "https://scenes.frameos.net";
    process.env.FRAMEOS_SESSION_COOKIE_DOMAIN = "frameos.net";

    expect(sessionCookieOptions()).toMatchObject({
      domain: "frameos.net",
      httpOnly: true,
      path: "/",
      sameSite: "lax",
    });
  });

  it("keeps the session host-only on one-origin localhost", () => {
    process.env.FRAMEOS_CLOUD_APP_URL = "http://localhost:3000";
    process.env.FRAMEOS_ACCOUNT_APP_URL = "http://localhost:3000";
    process.env.FRAMEOS_SCENES_APP_URL = "http://localhost:3000";
    delete process.env.FRAMEOS_SESSION_COOKIE_DOMAIN;

    expect(sessionCookieOptions()).not.toHaveProperty("domain");
  });

  it("defaults to the idle window and accepts a shorter one", () => {
    expect(sessionCookieOptions().maxAge).toBe(sessionIdleMaxAgeSeconds);
    expect(sessionCookieOptions(120).maxAge).toBe(120);
    // Never a negative maxAge, which browsers read as a session cookie
    // rather than as "already expired".
    expect(sessionCookieOptions(-5).maxAge).toBe(0);
  });
});

describe("session lifetime", () => {
  it("refreshes far more often than the idle window it maintains", () => {
    expect(sessionRefreshIntervalSeconds).toBeLessThan(
      sessionIdleMaxAgeSeconds / 100,
    );
    // The complaint that started this was a daily re-login; anything under a
    // week would still read as "it logs me out constantly".
    expect(sessionIdleMaxAgeSeconds).toBeGreaterThanOrEqual(
      7 * 24 * 60 * 60,
    );
    // Activity slides the idle deadline, so the ceiling has to be the longer
    // of the two or it could never be reached.
    expect(sessionAbsoluteMaxAgeSeconds).toBeGreaterThan(
      sessionIdleMaxAgeSeconds,
    );
  });
});

describe("sessionCookieMaxAgeSeconds", () => {
  const now = new Date("2026-01-01T00:00:00.000Z");

  it("uses the idle deadline while the ceiling is far away", () => {
    expect(
      sessionCookieMaxAgeSeconds(
        {
          absoluteExpiresAt: new Date(now.getTime() + 90 * 86_400_000),
          expiresAt: new Date(now.getTime() + 30 * 86_400_000),
        },
        now,
      ),
    ).toBe(30 * 86_400);
  });

  it("never lets the cookie outlive the absolute ceiling", () => {
    expect(
      sessionCookieMaxAgeSeconds(
        {
          absoluteExpiresAt: new Date(now.getTime() + 3_600_000),
          expiresAt: new Date(now.getTime() + 30 * 86_400_000),
        },
        now,
      ),
    ).toBe(3_600);
  });
});

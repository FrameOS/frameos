import { afterEach, describe, expect, it } from "vitest";
import {
  assertSharedSessionConfigured,
  assertDatabaseUrlConfigured,
  getBaseUrl,
  getAccountBaseUrl,
  getAccountPath,
  getAccountUrl,
  getCloudBaseUrl,
  getGoogleCallbackUrl,
  getGoogleOAuthConfig,
  getPostLogoutRedirectUrl,
  getScenesBaseUrl,
  getSessionCookieDomain,
  hasGoogleOAuth,
} from "./env";

const originalAppUrl = process.env.FRAMEOS_CLOUD_APP_URL;
const originalAccountUrl = process.env.FRAMEOS_ACCOUNT_APP_URL;
const originalScenesUrl = process.env.FRAMEOS_SCENES_APP_URL;
const originalCookieDomain = process.env.FRAMEOS_SESSION_COOKIE_DOMAIN;
const originalDatabaseUrl = process.env.DATABASE_URL;
const originalGoogleClientId = process.env.GOOGLE_CLIENT_ID;
const originalGoogleClientSecret = process.env.GOOGLE_CLIENT_SECRET;

function restore(key: string, value: string | undefined) {
  if (value) {
    process.env[key] = value;
  } else {
    delete process.env[key];
  }
}

afterEach(() => {
  restore("FRAMEOS_CLOUD_APP_URL", originalAppUrl);
  restore("FRAMEOS_ACCOUNT_APP_URL", originalAccountUrl);
  restore("FRAMEOS_SCENES_APP_URL", originalScenesUrl);
  restore("FRAMEOS_SESSION_COOKIE_DOMAIN", originalCookieDomain);
  restore("DATABASE_URL", originalDatabaseUrl);
  restore("GOOGLE_CLIENT_ID", originalGoogleClientId);
  restore("GOOGLE_CLIENT_SECRET", originalGoogleClientSecret);
});

describe("env", () => {
  it("defaults the auth base URL for local development", () => {
    delete process.env.FRAMEOS_CLOUD_APP_URL;
    expect(getBaseUrl()).toBe("http://localhost:3000");
  });

  it("uses configured app base URL", () => {
    process.env.FRAMEOS_CLOUD_APP_URL = "https://cloud.frameos.net";
    expect(getBaseUrl()).toBe("https://cloud.frameos.net");
    expect(getCloudBaseUrl()).toBe("https://cloud.frameos.net");
  });

  it("keeps scenes on the cloud origin by default and accepts a split origin", () => {
    process.env.FRAMEOS_CLOUD_APP_URL = "http://localhost:3000";
    delete process.env.FRAMEOS_SCENES_APP_URL;
    expect(getScenesBaseUrl()).toBe("http://localhost:3000");

    process.env.FRAMEOS_SCENES_APP_URL = "https://scenes.frameos.net";
    expect(getScenesBaseUrl()).toBe("https://scenes.frameos.net");
  });

  it("maps clean account paths only when the account origin is split", () => {
    process.env.FRAMEOS_CLOUD_APP_URL = "http://localhost:3000";
    delete process.env.FRAMEOS_ACCOUNT_APP_URL;
    expect(getAccountBaseUrl()).toBe("http://localhost:3000");
    expect(getAccountPath("/account/scenes")).toBe("/account/scenes");
    expect(getAccountUrl("/account")).toBe("http://localhost:3000/account");

    process.env.FRAMEOS_ACCOUNT_APP_URL = "https://account.frameos.net";
    expect(getAccountPath("/account/installs")).toBe("/backends");
    expect(getAccountPath("/account/scenes")).toBe("/scenes");
    expect(getAccountUrl("/account/scenes")).toBe(
      "https://account.frameos.net/scenes",
    );

    // Account merged into cloud with a split scenes host (production shape)
    // still uses clean paths — only a fully single-origin dev setup keeps
    // the raw /account/* routes.
    delete process.env.FRAMEOS_ACCOUNT_APP_URL;
    process.env.FRAMEOS_CLOUD_APP_URL = "https://cloud.frameos.net";
    process.env.FRAMEOS_SCENES_APP_URL = "https://scenes.frameos.net";
    expect(getAccountPath("/account/installs")).toBe("/backends");
    expect(getAccountUrl("/account/scenes")).toBe(
      "https://cloud.frameos.net/scenes",
    );
    process.env.FRAMEOS_ACCOUNT_APP_URL = "https://account.frameos.net";

    // The old account frame table shortens straight into the fleet SPA,
    // which is the one frames page now.
    expect(getAccountPath("/account/frames")).toBe("/frames");
    expect(getAccountUrl("/account/frames")).toBe(
      "https://account.frameos.net/frames",
    );
  });

  it("requires a parent-domain session cookie for split origins", () => {
    process.env.FRAMEOS_CLOUD_APP_URL = "https://cloud.frameos.net";
    process.env.FRAMEOS_ACCOUNT_APP_URL = "https://account.frameos.net";
    process.env.FRAMEOS_SCENES_APP_URL = "https://scenes.frameos.net";
    delete process.env.FRAMEOS_SESSION_COOKIE_DOMAIN;
    expect(() => assertSharedSessionConfigured()).toThrow(
      "FRAMEOS_SESSION_COOKIE_DOMAIN is required",
    );

    process.env.FRAMEOS_SESSION_COOKIE_DOMAIN = ".frameos.net";
    expect(getSessionCookieDomain()).toBe("frameos.net");
    expect(() => assertSharedSessionConfigured()).not.toThrow();
  });

  it("rejects a session cookie domain that does not cover both apps", () => {
    process.env.FRAMEOS_CLOUD_APP_URL = "https://cloud.frameos.net";
    process.env.FRAMEOS_ACCOUNT_APP_URL = "https://account.frameos.net";
    process.env.FRAMEOS_SCENES_APP_URL = "https://scenes.frameos.net";
    process.env.FRAMEOS_SESSION_COOKIE_DOMAIN = "example.com";

    expect(() => getSessionCookieDomain()).toThrow(
      "FRAMEOS_SESSION_COOKIE_DOMAIN does not cover account.frameos.net",
    );
  });

  it("derives Google callback and post-logout URLs from the base URL", () => {
    process.env.FRAMEOS_CLOUD_APP_URL = "http://localhost:3000";
    expect(getGoogleCallbackUrl()).toBe(
      "http://localhost:3000/api/auth/google/callback",
    );
    expect(getPostLogoutRedirectUrl()).toBe(
      "http://localhost:3000/login?status=signed_out",
    );
  });

  it("treats Google SSO as disabled until both client values are set", () => {
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    expect(getGoogleOAuthConfig()).toBeUndefined();
    expect(hasGoogleOAuth()).toBe(false);

    process.env.GOOGLE_CLIENT_ID = "client-id";
    expect(getGoogleOAuthConfig()).toBeUndefined();

    process.env.GOOGLE_CLIENT_SECRET = "client-secret";
    expect(getGoogleOAuthConfig()).toMatchObject({
      clientId: "client-id",
      clientSecret: "client-secret",
      issuerUrl: "https://accounts.google.com",
    });
    expect(hasGoogleOAuth()).toBe(true);
  });

  it("requires DATABASE_URL for runtime startup checks", () => {
    delete process.env.DATABASE_URL;

    expect(() => assertDatabaseUrlConfigured()).toThrow(
      "Missing required environment variable: DATABASE_URL",
    );
  });

  it("allows missing DATABASE_URL during tests when explicitly requested", () => {
    delete process.env.DATABASE_URL;

    expect(() =>
      assertDatabaseUrlConfigured({ allowTestEnvironment: true }),
    ).not.toThrow();
  });
});

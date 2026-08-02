import { afterEach, describe, expect, it } from "vitest";
import { sessionCookieOptions } from "./session";

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
});

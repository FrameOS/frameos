import { afterEach, describe, expect, it } from "vitest";
import { safeAuthReturnPath } from "./auth-cookies";

const originalCloudUrl = process.env.FRAMEOS_CLOUD_APP_URL;
const originalAccountUrl = process.env.FRAMEOS_ACCOUNT_APP_URL;
const originalScenesUrl = process.env.FRAMEOS_SCENES_APP_URL;

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
});

describe("safeAuthReturnPath", () => {
  it("accepts local paths and either configured first-party origin", () => {
    process.env.FRAMEOS_CLOUD_APP_URL = "https://cloud.frameos.net";
    process.env.FRAMEOS_ACCOUNT_APP_URL = "https://account.frameos.net";
    process.env.FRAMEOS_SCENES_APP_URL = "https://scenes.frameos.net";

    expect(safeAuthReturnPath("/account")).toBe("/account");
    expect(
      safeAuthReturnPath("https://scenes.frameos.net/account/scenes?q=mine"),
    ).toBe("https://scenes.frameos.net/account/scenes?q=mine");
    expect(safeAuthReturnPath("https://cloud.frameos.net/admin")).toBe(
      "https://cloud.frameos.net/admin",
    );
    expect(safeAuthReturnPath("https://account.frameos.net/scenes")).toBe(
      "https://account.frameos.net/scenes",
    );
  });

  it("rejects external, protocol-relative, and credentialed return URLs", () => {
    process.env.FRAMEOS_CLOUD_APP_URL = "https://cloud.frameos.net";
    process.env.FRAMEOS_ACCOUNT_APP_URL = "https://account.frameos.net";
    process.env.FRAMEOS_SCENES_APP_URL = "https://scenes.frameos.net";

    expect(safeAuthReturnPath("https://evil.example/account")).toBeUndefined();
    expect(safeAuthReturnPath("//evil.example/account")).toBeUndefined();
    // Dot segments must not resolve into a protocol-relative URL.
    expect(safeAuthReturnPath("/..//evil.example")).toBeUndefined();
    expect(safeAuthReturnPath("/.//evil.example/account")).toBeUndefined();
    expect(safeAuthReturnPath("/account/..//evil.example")).toBeUndefined();
    expect(safeAuthReturnPath("/..\\\\evil.example")).toBeUndefined();
    expect(safeAuthReturnPath("/account/../scenes")).toBe("/scenes");
    expect(
      safeAuthReturnPath("https://user@scenes.frameos.net/account/scenes"),
    ).toBeUndefined();
  });
});

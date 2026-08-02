import { NextRequest } from "next/server";
import { afterEach, describe, expect, it } from "vitest";
import { proxy } from "./proxy";

const originalAccountUrl = process.env.FRAMEOS_ACCOUNT_APP_URL;
const originalCloudUrl = process.env.FRAMEOS_CLOUD_APP_URL;
const originalScenesUrl = process.env.FRAMEOS_SCENES_APP_URL;

afterEach(() => {
  restore("FRAMEOS_ACCOUNT_APP_URL", originalAccountUrl);
  restore("FRAMEOS_CLOUD_APP_URL", originalCloudUrl);
  restore("FRAMEOS_SCENES_APP_URL", originalScenesUrl);
});

describe("proxy", () => {
  it("rewrites through the plain-HTTP localhost listener behind TLS termination", () => {
    process.env.FRAMEOS_ACCOUNT_APP_URL = "https://account.frameos.net";
    process.env.FRAMEOS_CLOUD_APP_URL = "https://cloud.frameos.net";
    process.env.FRAMEOS_SCENES_APP_URL = "https://scenes.frameos.net";

    const response = proxy(
      new NextRequest("https://localhost:3000/scenes?q=mine", {
        headers: { host: "account.frameos.net" },
      }),
    );

    expect(response.headers.get("x-middleware-rewrite")).toBe(
      "http://localhost:3000/account/scenes?q=mine",
    );
  });
});

function restore(key: string, value: string | undefined) {
  if (value) {
    process.env[key] = value;
  } else {
    delete process.env[key];
  }
}

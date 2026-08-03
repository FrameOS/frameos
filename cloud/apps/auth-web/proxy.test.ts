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
  it("rewrites through the plain-HTTP localhost listener behind TLS termination", async () => {
    process.env.FRAMEOS_ACCOUNT_APP_URL = "https://account.frameos.net";
    process.env.FRAMEOS_CLOUD_APP_URL = "https://cloud.frameos.net";
    process.env.FRAMEOS_SCENES_APP_URL = "https://scenes.frameos.net";

    const response = await proxy(
      new NextRequest("https://localhost:3000/scenes?q=mine", {
        headers: { host: "account.frameos.net" },
      }),
    );

    expect(response.headers.get("x-middleware-rewrite")).toBe(
      "http://localhost:3000/account/scenes?q=mine",
    );
  });

  // The session refresh runs here (it is the only place in Next 16 that may
  // set a cookie for an RSC navigation), but it must never reach for a
  // database on a request that carries no session — see the integration suite
  // for the refresh itself.
  it("passes anonymous requests through untouched", async () => {
    process.env.FRAMEOS_ACCOUNT_APP_URL = "http://localhost:3000";
    process.env.FRAMEOS_CLOUD_APP_URL = "http://localhost:3000";
    process.env.FRAMEOS_SCENES_APP_URL = "http://localhost:3000";

    const response = await proxy(
      new NextRequest("http://localhost:3000/login", {
        headers: { host: "localhost:3000" },
      }),
    );

    expect(response.headers.get("set-cookie")).toBeNull();
  });
});

function restore(key: string, value: string | undefined) {
  if (value) {
    process.env[key] = value;
  } else {
    delete process.env[key];
  }
}

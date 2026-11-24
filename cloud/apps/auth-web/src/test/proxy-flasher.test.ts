// The flasher host (cloud/docs/flasher.md) takes jobs — a frame's API key and
// Wi-Fi password among them — from pages it does not know, on an origin the
// session cookie is also sent to. proxy.ts keeps that host from being a door
// to the signed-in API: 404 for every API path but the firmware, and the
// cookie and any bearer taken off what it does serve.
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { proxy } from "../../proxy";
import { sessionCookieName } from "../lib/session-cookie";
import { flasherRootHeader } from "../lib/surfaces";

const saved = {
  account: process.env.FRAMEOS_ACCOUNT_APP_URL,
  cloud: process.env.FRAMEOS_CLOUD_APP_URL,
  database: process.env.DATABASE_URL,
  flasher: process.env.FRAMEOS_FLASHER_APP_URL,
  scenes: process.env.FRAMEOS_SCENES_APP_URL,
};

function restore(key: string, value: string | undefined) {
  if (value) {
    process.env[key] = value;
  } else {
    delete process.env[key];
  }
}

beforeEach(() => {
  delete process.env.FRAMEOS_ACCOUNT_APP_URL;
  // No database: the session refresh is not what is under test.
  delete process.env.DATABASE_URL;
  process.env.FRAMEOS_CLOUD_APP_URL = "https://cloud.frameos.net";
  process.env.FRAMEOS_SCENES_APP_URL = "https://scenes.frameos.net";
  process.env.FRAMEOS_FLASHER_APP_URL = "https://flash.frameos.net";
});

afterEach(() => {
  restore("FRAMEOS_ACCOUNT_APP_URL", saved.account);
  restore("FRAMEOS_CLOUD_APP_URL", saved.cloud);
  restore("DATABASE_URL", saved.database);
  restore("FRAMEOS_FLASHER_APP_URL", saved.flasher);
  restore("FRAMEOS_SCENES_APP_URL", saved.scenes);
});

// As nginx hands a request over: Next sees its own listener, the host is the
// header's.
function request(host: string, path: string, method = "GET", extra: Record<string, string> = {}) {
  return new NextRequest(new URL(path, "http://localhost:3000"), {
    headers: {
      authorization: "Bearer fc_api_something",
      cookie: `${sessionCookieName}=a-session; theme=dark`,
      host,
      ...extra,
    },
    method,
  });
}

function forwardedHeaders(response: Response) {
  const listed = response.headers.get("x-middleware-override-headers");
  return listed === null ? undefined : listed.split(",");
}

describe("the flasher host", () => {
  it("answers 404 for the signed-in API", async () => {
    for (const path of ["/api/settings?reveal=1", "/api/account/export", "/api/frames", "/api/photos/albums"]) {
      const response = await proxy(request("flash.frameos.net", path));
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "not_found" });
    }
  });

  it("serves the firmware and its page without the cookie or a bearer", async () => {
    for (const path of ["/api/frames/firmware", "/api/frames/firmware?platform=esp32-s3-generic&signature=1", "/"]) {
      const response = await proxy(request("flash.frameos.net", path));
      expect(response.status).toBe(200);
      const forwarded = forwardedHeaders(response);
      expect(forwarded).toBeDefined();
      expect(forwarded).not.toContain("cookie");
      expect(forwarded).not.toContain("authorization");
      expect(response.headers.get("set-cookie")).toBeNull();
    }
  });

  it("marks only its own root for the rewrite, and drops a mark a client sent", async () => {
    const root = await proxy(request("flash.frameos.net", "/"));
    expect(root.headers.get(`x-middleware-request-${flasherRootHeader}`)).toBe("1");

    const forged = await proxy(request("cloud.frameos.net", "/frames", "GET", { [flasherRootHeader]: "1" }));
    expect(forged.headers.get(`x-middleware-request-${flasherRootHeader}`)).toBeNull();
    expect(forwardedHeaders(forged)).not.toContain(flasherRootHeader);
  });
});

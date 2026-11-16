import { NextRequest } from "next/server";
import { afterEach, describe, expect, it } from "vitest";
import { proxy } from "./proxy";
import {
  playgroundRootHeader,
  playgroundRootRewrite,
} from "./src/lib/surfaces";

const originalAccountUrl = process.env.FRAMEOS_ACCOUNT_APP_URL;
const originalCloudUrl = process.env.FRAMEOS_CLOUD_APP_URL;
const originalScenesUrl = process.env.FRAMEOS_SCENES_APP_URL;
const originalPlaygroundUrl = process.env.FRAMEOS_PLAYGROUND_APP_URL;

afterEach(() => {
  restore("FRAMEOS_ACCOUNT_APP_URL", originalAccountUrl);
  restore("FRAMEOS_CLOUD_APP_URL", originalCloudUrl);
  restore("FRAMEOS_SCENES_APP_URL", originalScenesUrl);
  restore("FRAMEOS_PLAYGROUND_APP_URL", originalPlaygroundUrl);
});

describe("proxy", () => {
  // Production as nginx hands it over (cloud/docs/playground.md). A rewrite
  // returned from here left the server and came back as a request the
  // surface rules redirected to the root again, so the root is a mark that
  // next.config.ts rewrites inside the router (playgroundRootRewrite).
  it("marks the playground host's root for the config rewrite", async () => {
    configureProduction();

    const response = await proxy(
      new NextRequest("https://localhost:3000/", {
        headers: { host: "playground.frameos.net" },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-rewrite")).toBeNull();
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(
      response.headers.get(`x-middleware-request-${playgroundRootHeader}`),
    ).toBe("1");
    expect(playgroundRootRewrite).toEqual({
      source: "/",
      has: [{ type: "header", key: playgroundRootHeader, value: "1" }],
      destination: "/playground",
    });
  });

  it("drops a playground mark a client sent anywhere else", async () => {
    configureProduction();

    const response = await proxy(
      new NextRequest("https://localhost:3000/", {
        headers: { host: "scenes.frameos.net", [playgroundRootHeader]: "1" },
      }),
    );

    expect(response.status).toBe(200);
    const overridden = (
      response.headers.get("x-middleware-override-headers") ?? ""
    ).split(",");
    expect(overridden).toContain("host");
    expect(overridden).not.toContain(playgroundRootHeader);
  });

  it("leaves requests without a mark alone", async () => {
    configureProduction();

    const response = await proxy(
      new NextRequest("https://localhost:3000/", {
        headers: { host: "scenes.frameos.net" },
      }),
    );

    expect(response.headers.get("x-middleware-override-headers")).toBeNull();
  });

  it("redirects the old clean account paths into the frames workspace", async () => {
    process.env.FRAMEOS_ACCOUNT_APP_URL = "https://account.frameos.net";
    process.env.FRAMEOS_CLOUD_APP_URL = "https://cloud.frameos.net";
    process.env.FRAMEOS_SCENES_APP_URL = "https://scenes.frameos.net";

    const response = await proxy(
      new NextRequest("https://localhost:3000/backends", {
        headers: { host: "account.frameos.net" },
      }),
    );

    // 307 and no-store: which path serves which page is deployment config
    // (the account pages moved into the SPA in 2026.10), and a permanent
    // redirect would freeze into browser caches.
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "https://account.frameos.net/account/backends",
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
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

// The production hosts (cloud/docs/deployment.md): the account surface on the
// cloud origin, the store and the playground on their own.
function configureProduction() {
  delete process.env.FRAMEOS_ACCOUNT_APP_URL;
  process.env.FRAMEOS_CLOUD_APP_URL = "https://cloud.frameos.net";
  process.env.FRAMEOS_SCENES_APP_URL = "https://scenes.frameos.net";
  process.env.FRAMEOS_PLAYGROUND_APP_URL = "https://playground.frameos.net";
}

function restore(key: string, value: string | undefined) {
  if (value) {
    process.env[key] = value;
  } else {
    delete process.env[key];
  }
}

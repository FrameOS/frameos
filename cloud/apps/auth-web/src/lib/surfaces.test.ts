import { afterEach, describe, expect, it } from "vitest";
import { resolveSurfaceRoute } from "./surfaces";

const originalAccountUrl = process.env.FRAMEOS_ACCOUNT_APP_URL;
const originalCloudUrl = process.env.FRAMEOS_CLOUD_APP_URL;
const originalScenesUrl = process.env.FRAMEOS_SCENES_APP_URL;

function restore(key: string, value: string | undefined) {
  if (value) {
    process.env[key] = value;
  } else {
    delete process.env[key];
  }
}

afterEach(() => {
  restore("FRAMEOS_ACCOUNT_APP_URL", originalAccountUrl);
  restore("FRAMEOS_CLOUD_APP_URL", originalCloudUrl);
  restore("FRAMEOS_SCENES_APP_URL", originalScenesUrl);
});

describe("surface routing", () => {
  it("keeps the existing localhost routes when every surface shares one origin", () => {
    process.env.FRAMEOS_CLOUD_APP_URL = "http://localhost:3000";
    delete process.env.FRAMEOS_ACCOUNT_APP_URL;
    delete process.env.FRAMEOS_SCENES_APP_URL;

    expect(
      resolveSurfaceRoute(new URL("http://localhost:3000/account/scenes")),
    ).toBeUndefined();
    expect(
      resolveSurfaceRoute(new URL("http://localhost:3000/")),
    ).toBeUndefined();
  });

  it("keeps cloud as the login domain", () => {
    configureSplitOrigins();

    expectRoute("https://cloud.frameos.net/", {
      kind: "redirect",
      url: "https://cloud.frameos.net/login",
    });
    expect(
      resolveSurfaceRoute(new URL("https://cloud.frameos.net/login")),
    ).toBeUndefined();
    expectRoute("https://account.frameos.net/login?status=signed_out", {
      kind: "redirect",
      url: "https://cloud.frameos.net/login?status=signed_out",
    });
  });

  it("moves legacy account URLs onto clean account-domain paths", () => {
    configureSplitOrigins();

    for (const [legacy, canonical] of [
      ["/account", "/backends"],
      ["/account/installs", "/backends"],
      ["/account/frames", "/frames"],
      ["/account/ai", "/ai"],
      ["/account/settings", "/settings"],
      ["/account/backups", "/backups"],
      ["/account/activity", "/activity"],
      ["/account/developer", "/developer"],
      ["/admin/scenes", "/admin/scenes"],
      ["/device", "/device"],
    ]) {
      expectRoute(`https://cloud.frameos.net${legacy}`, {
        kind: "redirect",
        url: `https://account.frameos.net${canonical}`,
      });
    }
  });

  it("serves account paths that keep their full form instead of self-redirecting", () => {
    configureSplitOrigins();

    // getAccountPath returns these unchanged; a redirect would loop forever.
    expect(
      resolveSurfaceRoute(new URL("https://account.frameos.net/admin/scenes")),
    ).toBeUndefined();
    expect(
      resolveSurfaceRoute(new URL("https://account.frameos.net/device")),
    ).toBeUndefined();
  });

  it("serves the Nim converter on the scenes host and sends the other hosts there", () => {
    process.env.FRAMEOS_CLOUD_APP_URL = "https://cloud.frameos.net";
    process.env.FRAMEOS_ACCOUNT_APP_URL = "https://account.frameos.net";
    process.env.FRAMEOS_SCENES_APP_URL = "https://scenes.frameos.net";

    expect(
      resolveSurfaceRoute(new URL("https://scenes.frameos.net/nim-converter")),
    ).toBeUndefined();
    expectRoute("https://cloud.frameos.net/nim-converter", {
      kind: "redirect",
      url: "https://scenes.frameos.net/nim-converter",
    });
    expectRoute("https://account.frameos.net/nim-converter", {
      kind: "redirect",
      url: "https://scenes.frameos.net/nim-converter",
    });
    // The API behind it stays reachable on every host, like every route.
    expect(
      resolveSurfaceRoute(new URL("https://cloud.frameos.net/api/scenes/convert")),
    ).toBeUndefined();
  });

  it("moves the private scene list onto the scenes host as /my-scenes", () => {
    configureSplitOrigins();

    // Its old homes — /account/scenes and the clean /scenes alias — redirect
    // from every host; the scenes host serves it.
    for (const origin of [
      "https://cloud.frameos.net",
      "https://account.frameos.net",
      "https://scenes.frameos.net",
    ]) {
      for (const legacy of ["/account/scenes?q=clock", "/scenes?q=clock"]) {
        expectRoute(`${origin}${legacy}`, {
          kind: "redirect",
          url: "https://scenes.frameos.net/my-scenes?q=clock",
        });
      }
    }
    expectRoute("https://cloud.frameos.net/my-scenes", {
      kind: "redirect",
      url: "https://scenes.frameos.net/my-scenes",
    });
    expectRoute("https://account.frameos.net/my-scenes", {
      kind: "redirect",
      url: "https://scenes.frameos.net/my-scenes",
    });
    expect(
      resolveSurfaceRoute(new URL("https://scenes.frameos.net/my-scenes")),
    ).toBeUndefined();
  });

  it("rewrites clean account paths to the existing app routes", () => {
    configureSplitOrigins();

    for (const [external, internal] of [
      ["/backends", "/account/installs"],
      ["/ai", "/account/ai"],
      ["/settings", "/account/settings"],
      ["/backups", "/account/backups"],
      ["/activity", "/account/activity"],
      ["/security", "/account/security"],
      ["/developer", "/account/developer"],
    ]) {
      expectRoute(`https://account.frameos.net${external}`, {
        kind: "rewrite",
        url: `https://account.frameos.net${internal}`,
      });
    }
    expectRoute("https://account.frameos.net/", {
      kind: "redirect",
      url: "https://account.frameos.net/frames",
    });
    expectRoute("https://account.frameos.net/installs", {
      kind: "redirect",
      url: "https://account.frameos.net/backends",
    });
  });

  it("serves the account surface on the cloud host when the origins merge", () => {
    configureMergedOrigins();

    // Root is the frames workspace; its own gate handles signed-out.
    expectRoute("https://cloud.frameos.net/", {
      kind: "redirect",
      url: "https://cloud.frameos.net/frames",
    });
    // Legacy /account/* URLs shorten in place on the same host.
    expectRoute("https://cloud.frameos.net/account/backups", {
      kind: "redirect",
      url: "https://cloud.frameos.net/backups",
    });
    expectRoute("https://cloud.frameos.net/account/installs", {
      kind: "redirect",
      url: "https://cloud.frameos.net/backends",
    });
    // Clean paths rewrite to the app routes.
    expectRoute("https://cloud.frameos.net/backends", {
      kind: "rewrite",
      url: "https://cloud.frameos.net/account/installs",
    });
    expectRoute("https://cloud.frameos.net/security", {
      kind: "rewrite",
      url: "https://cloud.frameos.net/account/security",
    });
    expectRoute("https://cloud.frameos.net/ai", {
      kind: "rewrite",
      url: "https://cloud.frameos.net/account/ai",
    });
    expectRoute("https://cloud.frameos.net/developer", {
      kind: "rewrite",
      url: "https://cloud.frameos.net/account/developer",
    });
    expectRoute("https://cloud.frameos.net/settings", {
      kind: "rewrite",
      url: "https://cloud.frameos.net/account/settings",
    });
    // Full-form paths serve directly instead of redirect-looping.
    for (const path of [
      "/frames",
      "/frames/5",
      "/admin/scenes",
      "/device",
    ]) {
      expect(
        resolveSurfaceRoute(new URL(`https://cloud.frameos.net${path}`)),
      ).toBeUndefined();
    }
    // Auth stays served, public scenes still move to the scenes host.
    expect(
      resolveSurfaceRoute(new URL("https://cloud.frameos.net/login")),
    ).toBeUndefined();
    expectRoute("https://cloud.frameos.net/s/sunrise", {
      kind: "redirect",
      url: "https://scenes.frameos.net/s/sunrise",
    });
    // The scenes host sends account pages to the merged cloud host.
    expectRoute("https://scenes.frameos.net/account/backups", {
      kind: "redirect",
      url: "https://cloud.frameos.net/backups",
    });
    // The old account frame table redirects into the frames SPA.
    expectRoute("https://cloud.frameos.net/account/frames", {
      kind: "redirect",
      url: "https://cloud.frameos.net/frames",
    });
  });

  it("keeps the frames SPA on the account domain", () => {
    configureSplitOrigins();

    expectRoute("https://cloud.frameos.net/frames", {
      kind: "redirect",
      url: "https://account.frameos.net/frames",
    });
    expectRoute("https://cloud.frameos.net/frames/5?tool=logs", {
      kind: "redirect",
      url: "https://account.frameos.net/frames/5?tool=logs",
    });
    expect(
      resolveSurfaceRoute(new URL("https://account.frameos.net/frames")),
    ).toBeUndefined();
    expect(
      resolveSurfaceRoute(
        new URL("https://account.frameos.net/frames/5/scenes"),
      ),
    ).toBeUndefined();
    expect(
      resolveSurfaceRoute(
        new URL("https://account.frameos.net/frames-app/static/main.js"),
      ),
    ).toBeUndefined();
  });

  it("serves the frame installer script on every host", () => {
    configureSplitOrigins();

    // curl doesn't follow our host conventions — /install.sh must resolve
    // as-is wherever the user pasted it from.
    expect(
      resolveSurfaceRoute(new URL("https://account.frameos.net/install.sh")),
    ).toBeUndefined();
    expect(
      resolveSurfaceRoute(new URL("https://cloud.frameos.net/install.sh")),
    ).toBeUndefined();
    expect(
      resolveSurfaceRoute(new URL("https://scenes.frameos.net/install.sh")),
    ).toBeUndefined();
  });

  it("keeps public scenes on the scenes domain", () => {
    configureSplitOrigins();

    expectRoute("https://cloud.frameos.net/s/sunrise?version=2", {
      kind: "redirect",
      url: "https://scenes.frameos.net/s/sunrise?version=2",
    });
    expectRoute("https://account.frameos.net/s/sunrise", {
      kind: "redirect",
      url: "https://scenes.frameos.net/s/sunrise",
    });
    expectRoute("https://cloud.frameos.net/scenes/sunrise", {
      kind: "redirect",
      url: "https://scenes.frameos.net/scenes/sunrise",
    });
    expect(
      resolveSurfaceRoute(new URL("https://scenes.frameos.net/")),
    ).toBeUndefined();
  });

  it("moves account and auth pages away from the scenes domain", () => {
    configureSplitOrigins();

    expectRoute("https://scenes.frameos.net/account/backups", {
      kind: "redirect",
      url: "https://account.frameos.net/backups",
    });
    expectRoute("https://scenes.frameos.net/login", {
      kind: "redirect",
      url: "https://cloud.frameos.net/login",
    });
  });

  it("leaves APIs on every host for compatibility", () => {
    configureSplitOrigins();

    for (const url of [
      "https://cloud.frameos.net/api/store/repository.json",
      "https://account.frameos.net/api/auth/logout",
      "https://scenes.frameos.net/api/account/scenes/upload",
    ]) {
      expect(resolveSurfaceRoute(new URL(url))).toBeUndefined();
    }
  });

  it("uses the preserved public Host behind the internal listener", () => {
    configureSplitOrigins();

    const route = resolveSurfaceRoute(
      new URL("http://127.0.0.1:3000/account/backups"),
      "cloud.frameos.net",
    );
    expect(route?.kind).toBe("redirect");
    expect(route?.destination.toString()).toBe(
      "https://account.frameos.net/backups",
    );
  });
});

function expectRoute(
  source: string,
  expected: { kind: "redirect" | "rewrite"; url: string },
) {
  const route = resolveSurfaceRoute(new URL(source));
  expect(route?.kind).toBe(expected.kind);
  expect(route?.destination.toString()).toBe(expected.url);
}

function configureSplitOrigins() {
  process.env.FRAMEOS_ACCOUNT_APP_URL = "https://account.frameos.net";
  process.env.FRAMEOS_CLOUD_APP_URL = "https://cloud.frameos.net";
  process.env.FRAMEOS_SCENES_APP_URL = "https://scenes.frameos.net";
}

// Production since 2026-08: the account surface shares the cloud origin and
// only the public store keeps its own hostname.
function configureMergedOrigins() {
  delete process.env.FRAMEOS_ACCOUNT_APP_URL;
  process.env.FRAMEOS_CLOUD_APP_URL = "https://cloud.frameos.net";
  process.env.FRAMEOS_SCENES_APP_URL = "https://scenes.frameos.net";
}

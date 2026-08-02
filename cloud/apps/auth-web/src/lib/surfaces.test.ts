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
      ["/account", "/"],
      ["/account/installs", "/"],
      ["/account/scenes?q=clock", "/scenes?q=clock"],
      ["/account/backups", "/backups"],
      ["/account/activity", "/activity"],
      ["/admin/scenes", "/admin/scenes"],
      ["/device", "/device"],
    ]) {
      expectRoute(`https://cloud.frameos.net${legacy}`, {
        kind: "redirect",
        url: `https://account.frameos.net${canonical}`,
      });
    }
  });

  it("rewrites clean account paths to the existing app routes", () => {
    configureSplitOrigins();

    for (const [external, internal] of [
      ["/", "/account/installs"],
      ["/scenes?q=mine", "/account/scenes?q=mine"],
      ["/backups", "/account/backups"],
      ["/activity", "/account/activity"],
    ]) {
      expectRoute(`https://account.frameos.net${external}`, {
        kind: "rewrite",
        url: `https://account.frameos.net${internal}`,
      });
    }
  });

  it("keeps the frames SPA on the account domain", () => {
    configureSplitOrigins();

    expectRoute("https://cloud.frameos.net/frames", {
      kind: "redirect",
      url: "https://account.frameos.net/frames",
    });
    expectRoute("https://cloud.frameos.net/frames/frames/5?tool=logs", {
      kind: "redirect",
      url: "https://account.frameos.net/frames/frames/5?tool=logs",
    });
    expect(
      resolveSurfaceRoute(new URL("https://account.frameos.net/frames")),
    ).toBeUndefined();
    expect(
      resolveSurfaceRoute(
        new URL("https://account.frameos.net/frames/scenes/5"),
      ),
    ).toBeUndefined();
    expect(
      resolveSurfaceRoute(
        new URL("https://account.frameos.net/frames-app/static/main.js"),
      ),
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

    expectRoute("https://scenes.frameos.net/account/scenes", {
      kind: "redirect",
      url: "https://account.frameos.net/scenes",
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
      new URL("http://127.0.0.1:3000/account/scenes?q=mine"),
      "cloud.frameos.net",
    );
    expect(route?.kind).toBe("redirect");
    expect(route?.destination.toString()).toBe(
      "https://account.frameos.net/scenes?q=mine",
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

import { afterEach, describe, expect, it } from "vitest";
import { flasherServesApi, isFlasherHost, isPlaygroundHost, resolveSurfaceRoute } from "./surfaces";

const originalAccountUrl = process.env.FRAMEOS_ACCOUNT_APP_URL;
const originalCloudUrl = process.env.FRAMEOS_CLOUD_APP_URL;
const originalScenesUrl = process.env.FRAMEOS_SCENES_APP_URL;
const originalPlaygroundUrl = process.env.FRAMEOS_PLAYGROUND_APP_URL;
const originalFlasherUrl = process.env.FRAMEOS_FLASHER_APP_URL;

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
  restore("FRAMEOS_PLAYGROUND_APP_URL", originalPlaygroundUrl);
  restore("FRAMEOS_FLASHER_APP_URL", originalFlasherUrl);
});

describe("surface routing", () => {
  // cloud/docs/flasher.md: flash.frameos.net in production, /flash on the
  // cloud origin without one.
  it("serves the flasher at the root of its own host", () => {
    configureMergedOrigins();
    process.env.FRAMEOS_FLASHER_APP_URL = "https://flash.frameos.net";

    expect(resolveSurfaceRoute(new URL("https://flash.frameos.net/"))).toEqual({ kind: "flasherRoot" });
    expect(resolveSurfaceRoute(new URL("https://localhost:3000/?board=seeed_reterminal_e1002"), "flash.frameos.net")).toEqual({
      kind: "flasherRoot",
    });
    expectRoute("https://flash.frameos.net/flash?board=custom", {
      kind: "redirect",
      url: "https://flash.frameos.net/?board=custom",
    });
    expectRoute("https://cloud.frameos.net/flash", {
      kind: "redirect",
      url: "https://flash.frameos.net/",
    });
    // Any other page is the cloud's; its bundle, logos and the firmware are
    // served on the flasher host as they are.
    expectRoute("https://flash.frameos.net/frames", {
      kind: "redirect",
      url: "https://cloud.frameos.net/frames",
    });
    for (const path of [
      "/frames-app/static/flasher.js",
      "/frames-app/flasher-scenes.json",
      "/logo-light.svg",
      "/api/frames/firmware",
    ]) {
      expect(resolveSurfaceRoute(new URL(`https://flash.frameos.net${path}`))).toBeUndefined();
    }
    expect(isFlasherHost(new URL("https://localhost:3000/"), "flash.frameos.net")).toBe(true);
    expect(isFlasherHost(new URL("https://cloud.frameos.net/"))).toBe(false);
  });

  // The flasher takes jobs from pages it does not know, on an origin the
  // session cookie is sent to: its host answers the firmware and nothing else.
  it("answers no API on the flasher host but the firmware", () => {
    configureMergedOrigins();
    process.env.FRAMEOS_FLASHER_APP_URL = "https://flash.frameos.net";

    for (const path of [
      "/api/settings?reveal=1",
      "/api/frames",
      "/api/frames/new",
      "/api/frames/firmware/extra",
      "/api/store/device/scenes",
      "/api/photos/albums",
    ]) {
      expect(resolveSurfaceRoute(new URL(`https://flash.frameos.net${path}`))).toEqual({ kind: "notFound" });
    }
    expect(resolveSurfaceRoute(new URL("https://flash.frameos.net/api/frames/firmware"), null, "POST")).toEqual({
      kind: "notFound",
    });
    expect(flasherServesApi("/api/frames/firmware", "GET")).toBe(true);
    expect(flasherServesApi("/api/frames/firmware", "HEAD")).toBe(true);
    // The cloud host is not the flasher's: its API stays as it is.
    expect(resolveSurfaceRoute(new URL("https://cloud.frameos.net/api/frames"))).toBeUndefined();
  });

  it("keeps the flasher a path of the cloud origin without its own host", () => {
    configureMergedOrigins();
    expect(resolveSurfaceRoute(new URL("https://cloud.frameos.net/flash"))).toBeUndefined();
    expect(isFlasherHost(new URL("https://cloud.frameos.net/flash"))).toBe(false);
  });

  // cloud/docs/playground.md: its own host in production, /playground on the
  // cloud origin without one.
  it("serves the playground at the root of its own host", () => {
    configureMergedOrigins();
    process.env.FRAMEOS_PLAYGROUND_APP_URL = "https://playground.frameos.net";

    expect(
      resolveSurfaceRoute(new URL("https://playground.frameos.net/")),
    ).toEqual({ kind: "playgroundRoot" });
    // The same request as nginx hands it over: Next sees its own listener,
    // the host is the header's.
    expect(
      resolveSurfaceRoute(
        new URL("https://localhost:3000/"),
        "playground.frameos.net",
      ),
    ).toEqual({ kind: "playgroundRoot" });
    expectRoute("https://playground.frameos.net/playground?x=1", {
      kind: "redirect",
      url: "https://playground.frameos.net/?x=1",
    });
    expectRoute("https://cloud.frameos.net/playground", {
      kind: "redirect",
      url: "https://playground.frameos.net/",
    });
    // Any other page is the cloud's; its runtime, scenes and the store's API
    // are served on the playground host as they are.
    expectRoute("https://playground.frameos.net/login", {
      kind: "redirect",
      url: "https://cloud.frameos.net/login",
    });
    for (const path of [
      "/frameos-wasm/preview-worker.js",
      "/playground-assets/scenes.json",
      "/api/store/device/scenes",
      "/api/store/preview-proxy",
    ]) {
      expect(
        resolveSurfaceRoute(new URL(`https://playground.frameos.net${path}`)),
      ).toBeUndefined();
    }
  });

  // The playground runs anyone's scene on an origin the session cookie is
  // sent to, so its host answers only what the playground itself asks for.
  it("answers no API on the playground host beyond the store's public reads", () => {
    configureMergedOrigins();
    process.env.FRAMEOS_PLAYGROUND_APP_URL = "https://playground.frameos.net";

    for (const path of [
      "/api/settings?reveal=1",
      "/api/account/export",
      "/api/frames",
      "/api/photos/albums",
      "/api/store/account/scenes",
      "/api/store/browse",
      "/api/mcp",
      "/api",
    ]) {
      expect(
        resolveSurfaceRoute(new URL(`https://playground.frameos.net${path}`)),
      ).toEqual({ kind: "notFound" });
      // The same request as nginx hands it over.
      expect(
        resolveSurfaceRoute(
          new URL(`https://localhost:3000${path}`),
          "playground.frameos.net",
        ),
      ).toEqual({ kind: "notFound" });
    }
    for (const path of [
      "/api/store/device/scenes?limit=24",
      "/api/store/scenes/abc/scenes.json",
      "/api/store/scenes/abc/image",
      "/api/store/preview-proxy",
    ]) {
      expect(
        resolveSurfaceRoute(new URL(`https://playground.frameos.net${path}`)),
      ).toBeUndefined();
    }
    // The reads are reads: only the preview proxy takes a POST there.
    expect(
      resolveSurfaceRoute(
        new URL("https://playground.frameos.net/api/store/scenes/abc/report"),
        undefined,
        "POST",
      ),
    ).toEqual({ kind: "notFound" });
    expect(
      resolveSurfaceRoute(
        new URL("https://playground.frameos.net/api/store/preview-proxy"),
        undefined,
        "POST",
      ),
    ).toBeUndefined();
    // Every other host keeps its API.
    expect(
      resolveSurfaceRoute(new URL("https://cloud.frameos.net/api/settings")),
    ).toBeUndefined();
    expect(isPlaygroundHost(new URL("https://cloud.frameos.net/"))).toBe(false);
    expect(isPlaygroundHost(new URL("https://playground.frameos.net/"))).toBe(true);
  });

  it("keeps the API on a playground that is a path of the cloud origin", () => {
    configureMergedOrigins();
    delete process.env.FRAMEOS_PLAYGROUND_APP_URL;

    expect(
      resolveSurfaceRoute(new URL("https://cloud.frameos.net/api/settings")),
    ).toBeUndefined();
    expect(isPlaygroundHost(new URL("https://cloud.frameos.net/"))).toBe(false);
  });

  it("serves the playground on the cloud origin when it has no host", () => {
    configureMergedOrigins();
    delete process.env.FRAMEOS_PLAYGROUND_APP_URL;

    expect(
      resolveSurfaceRoute(new URL("https://cloud.frameos.net/playground")),
    ).toBeUndefined();
  });

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

  // The account pages are pages of the frames workspace SPA since 2026.10,
  // at their old /account/<page> addresses: the cloud host sends them to the
  // account host, and the sections that were renamed land on their page.
  it("moves account URLs to the account domain, renamed sections included", () => {
    configureSplitOrigins();

    for (const [legacy, canonical] of [
      ["/account", "/account/backends"],
      ["/account/installs", "/account/backends"],
      ["/account/frames", "/frames"],
      ["/account/ai", "/account/usage#ai"],
      ["/account/usage", "/account/usage"],
      ["/account/settings", "/account/services"],
      ["/account/backups", "/account/backups"],
      ["/account/activity", "/account/activity"],
      ["/account/security", "/account/security"],
      ["/account/developer", "/account/developer"],
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

    // Its old home — /account/scenes — redirects from every host; the
    // scenes host serves it. (/scenes, once its clean alias, is the SPA's
    // scenes library since 2026.10 and lives on the account host.)
    for (const origin of [
      "https://cloud.frameos.net",
      "https://account.frameos.net",
      "https://scenes.frameos.net",
    ]) {
      expectRoute(`${origin}/account/scenes?q=clock`, {
        kind: "redirect",
        url: "https://scenes.frameos.net/my-scenes?q=clock",
      });
    }
    for (const origin of ["https://cloud.frameos.net", "https://scenes.frameos.net"]) {
      expectRoute(`${origin}/scenes?q=clock`, {
        kind: "redirect",
        url: "https://account.frameos.net/scenes?q=clock",
      });
    }
    expect(
      resolveSurfaceRoute(new URL("https://account.frameos.net/scenes?q=clock")),
    ).toBeUndefined();
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

  // The clean paths the sections had on a split host (/backends, /settings,
  // …) are in bookmarks and old emails; each redirects to its /account page.
  it("redirects the old clean account paths to their /account pages", () => {
    configureSplitOrigins();

    for (const [legacy, page] of [
      ["/backends", "/account/backends"],
      ["/installs", "/account/backends"],
      ["/ai", "/account/usage#ai"],
      ["/usage", "/account/usage"],
      ["/settings", "/account/services"],
      ["/backups", "/account/backups"],
      ["/activity", "/account/activity"],
      ["/security", "/account/security"],
      ["/developer", "/account/developer"],
    ]) {
      expectRoute(`https://account.frameos.net${legacy}`, {
        kind: "redirect",
        url: `https://account.frameos.net${page}`,
      });
    }
    expectRoute("https://account.frameos.net/", {
      kind: "redirect",
      url: "https://account.frameos.net/home",
    });
    // The query rides along: a filtered backups bookmark stays filtered.
    expectRoute("https://account.frameos.net/backups?kind=frames", {
      kind: "redirect",
      url: "https://account.frameos.net/account/backups?kind=frames",
    });
  });

  it("serves the account surface on the cloud host when the origins merge", () => {
    configureMergedOrigins();

    // Root is the workspace's home page; its own gate handles signed-out.
    expectRoute("https://cloud.frameos.net/", {
      kind: "redirect",
      url: "https://cloud.frameos.net/home",
    });
    // Renamed sections redirect to their page on the same host.
    expectRoute("https://cloud.frameos.net/account/installs", {
      kind: "redirect",
      url: "https://cloud.frameos.net/account/backends",
    });
    // So do the clean paths they once shortened to.
    expectRoute("https://cloud.frameos.net/backends", {
      kind: "redirect",
      url: "https://cloud.frameos.net/account/backends",
    });
    expectRoute("https://cloud.frameos.net/security", {
      kind: "redirect",
      url: "https://cloud.frameos.net/account/security",
    });
    expectRoute("https://cloud.frameos.net/ai", {
      kind: "redirect",
      url: "https://cloud.frameos.net/account/usage#ai",
    });
    expectRoute("https://cloud.frameos.net/developer", {
      kind: "redirect",
      url: "https://cloud.frameos.net/account/developer",
    });
    expectRoute("https://cloud.frameos.net/settings", {
      kind: "redirect",
      url: "https://cloud.frameos.net/account/services",
    });
    // Full-form paths serve directly instead of redirect-looping.
    for (const path of [
      "/frames",
      "/frames/5",
      "/account/backends",
      "/account/developer",
      "/apps",
      "/apps/system/data%2Fclock",
      "/home",
      "/photos",
      "/scenes",
      "/scenes?page=cloud",
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
    // The scenes host sends account pages to the merged cloud host, the
    // SPA's apps and photos pages included.
    expectRoute("https://scenes.frameos.net/account/backups", {
      kind: "redirect",
      url: "https://cloud.frameos.net/account/backups",
    });
    expectRoute("https://scenes.frameos.net/photos", {
      kind: "redirect",
      url: "https://cloud.frameos.net/photos",
    });
    expectRoute("https://scenes.frameos.net/apps/frames/abc", {
      kind: "redirect",
      url: "https://cloud.frameos.net/apps/frames/abc",
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
      url: "https://account.frameos.net/account/backups",
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
    expect(
      route?.kind === "redirect" ? route.destination.toString() : undefined,
    ).toBe(
      "https://account.frameos.net/account/backups",
    );
  });
});

function expectRoute(
  source: string,
  expected: { kind: "redirect"; url: string },
) {
  const route = resolveSurfaceRoute(new URL(source));
  expect(route?.kind).toBe(expected.kind);
  expect(
    route?.kind === "redirect" ? route.destination.toString() : undefined,
  ).toBe(expected.url);
}

function configureSplitOrigins() {
  process.env.FRAMEOS_ACCOUNT_APP_URL = "https://account.frameos.net";
  process.env.FRAMEOS_CLOUD_APP_URL = "https://cloud.frameos.net";
  process.env.FRAMEOS_SCENES_APP_URL = "https://scenes.frameos.net";
  delete process.env.FRAMEOS_PLAYGROUND_APP_URL;
  delete process.env.FRAMEOS_FLASHER_APP_URL;
}

// Production since 2026-08: the account surface shares the cloud origin and
// only the public store keeps its own hostname.
function configureMergedOrigins() {
  delete process.env.FRAMEOS_ACCOUNT_APP_URL;
  process.env.FRAMEOS_CLOUD_APP_URL = "https://cloud.frameos.net";
  process.env.FRAMEOS_SCENES_APP_URL = "https://scenes.frameos.net";
  delete process.env.FRAMEOS_PLAYGROUND_APP_URL;
  delete process.env.FRAMEOS_FLASHER_APP_URL;
}

// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  cloudAssetsBasePath,
  cloudFrameUrl,
  cloudFramesUrl,
  cloudRouteBasePath,
  cloudSceneUrl,
  legacyCloudPathRedirect,
  cloudSettingsUrl,
} from "@frameos/cloud-frontend/src/routes";
import {
  accountPages,
  defaultAccountPageKey,
} from "../../../../../../frontend/src/scenes/settings/account/accountPages";
import { urls } from "../../../../../../frontend/src/urls";
import { accountSectionRedirects } from "../../lib/env";

// Next.js server components link INTO the SPA (the account frame table used
// to; the pending-enrollment and activity emails still do). The SPA mounts
// at /frames and, in cloud mode, drops its own /frames segment so a frame is
// /frames/:id and its scenes /frames/:id/scenes/:sceneId (it used to be
// /frames/frames/:id). The Next.js side uses cloud-frontend/src/routes.ts;
// this test is what keeps that helper honest, because it cannot call
// `urls.frame()` itself (it reads window.FRAMEOS_APP_CONFIG, absent during
// SSR).

function withCloudSpaConfig<T>(run: () => T): T {
  (window as unknown as { FRAMEOS_APP_CONFIG?: unknown }).FRAMEOS_APP_CONFIG = {
    assets_base_path: cloudAssetsBasePath,
    cloudMode: true,
    ingress_path: "",
    route_base_path: cloudRouteBasePath,
  };
  return run();
}

afterEach(() => {
  delete (window as unknown as { FRAMEOS_APP_CONFIG?: unknown })
    .FRAMEOS_APP_CONFIG;
});

describe("cloud SPA route helpers", () => {
  it("agrees with the SPA's own urls.frame() under the SPA's config", () => {
    const frameId = "7b3f1c2e-9d4a-4f61-8f0c-1a2b3c4d5e6f";
    const fromSpa = withCloudSpaConfig(() => urls.frame(frameId));
    expect(cloudFrameUrl(frameId)).toBe(fromSpa);
  });

  it("agrees with the SPA's own urls.frames()", () => {
    expect(cloudFramesUrl()).toBe(withCloudSpaConfig(() => urls.frames()));
  });

  it("puts a frame directly under /frames", () => {
    expect(cloudFrameUrl("abc")).toBe("/frames/abc");
  });

  it("nests a frame's scenes under the frame, like urls.scenes()", () => {
    expect(cloudSceneUrl("abc", "def")).toBe("/frames/abc/scenes/def");
    expect(cloudSceneUrl("abc")).toBe("/frames/abc/scenes");
    expect(cloudSceneUrl("abc", "def")).toBe(
      withCloudSpaConfig(() => urls.scenes("abc", "def")),
    );
    expect(cloudSceneUrl("abc")).toBe(withCloudSpaConfig(() => urls.scenes("abc")));
  });

  it("passes the tool query through the same way urls.frame does", () => {
    const fromSpa = withCloudSpaConfig(() => urls.frame("abc", "settings"));
    expect(cloudFrameUrl("abc", "settings")).toBe(fromSpa);
  });

  // The settings are the account's pages, scenes of this SPA at their old
  // /account/<page> addresses (frontend/src/scenes/settings/account), outside
  // the /frames mount; the Next.js side links to them through
  // cloudSettingsUrl and env.ts's redirect table, which this keeps in step
  // with the SPA's keys.
  it("agrees with the SPA's own urls.settings(), page by page", () => {
    expect(cloudSettingsUrl()).toBe("/account");
    expect(cloudSettingsUrl()).toBe(withCloudSpaConfig(() => urls.settings()));
    for (const page of accountPages) {
      expect(cloudSettingsUrl(page.key)).toBe(`/account/${page.key}`);
      expect(cloudSettingsUrl(page.key)).toBe(
        withCloudSpaConfig(() => urls.settings(page.key)),
      );
    }
    expect(withCloudSpaConfig(() => urls.accountUsage())).toBe("/account/usage");
  });

  it("redirects every renamed account section onto a page the SPA has", () => {
    const pageKeys = new Set<string>(accountPages.map((page) => page.key));
    for (const [section, target] of accountSectionRedirects) {
      if (section === "/account/frames") {
        expect(target).toBe(cloudFramesUrl());
        continue;
      }
      const match = /^\/account\/([^/#?]+)/.exec(target);
      expect(match, `${section} → ${target}`).not.toBeNull();
      expect(pageKeys.has(match![1]!), `${section} → ${target}`).toBe(true);
      // A page's own address never redirects (the route would loop).
      expect(pageKeys.has(section.slice("/account/".length)), section).toBe(false);
    }
    expect(accountSectionRedirects.get("/account")).toBe(cloudSettingsUrl(defaultAccountPageKey));
    expect(defaultAccountPageKey).toBe(accountPages[0]?.key);
  });

  it("registers the settings scene and its page route in the cloud SPA", async () => {
    // The specifier is a variable ON PURPOSE: scenes.tsx transitively
    // imports the whole React SPA, and a static (or literal-dynamic) import
    // would drag all of it into this app's stricter tsc program — vitest
    // resolves the runtime import fine either way.
    const scenesModulePath = "@frameos/cloud-frontend/src/scenes/scenes";
    const { getRoutes, scenes } = (await import(scenesModulePath)) as {
      getRoutes: () => Record<string, string>;
      scenes: Record<string, unknown>;
    };
    const routes = withCloudSpaConfig(() => getRoutes());
    expect(routes["/account"]).toBe("settings");
    expect(routes["/account/:page"]).toBe("settings");
    expect(scenes).toHaveProperty("settings");
  });

  // The shared SPA has its OWN sceneLogic and route table
  // (frontend/src/scenes/scenes.tsx), and the workspace shell reads THAT one
  // to decide which rail button is pending — not the wrapper's. With
  // /frames/:id registered first it reported "frame" for /frames/scenes, and
  // the Frame button span forever on the apps page.
  it("orders the shared SPA's route table for the cloud mount too", async () => {
    // Same variable-specifier trick as above; absolute so vitest resolves it
    // from the file system rather than from the project root.
    const scenesModulePath = new URL(
      "../../../../../../frontend/src/scenes/scenes.tsx",
      import.meta.url,
    ).pathname;
    const { getRoutes } = (await import(scenesModulePath)) as {
      getRoutes: () => Record<string, string>;
    };
    const routes = withCloudSpaConfig(() => getRoutes());
    const paths = Object.keys(routes);
    const frameIndex = paths.indexOf("/frames/:id");
    expect(frameIndex).toBeGreaterThan(-1);
    for (const literal of ["/frames/scenes", "/frames/:frameId/scenes"]) {
      expect(paths.indexOf(literal)).toBeGreaterThan(-1);
      expect(paths.indexOf(literal)).toBeLessThan(frameIndex);
    }
    // The apps and photos pages sit beside the mount, so they cannot
    // collide with a frame route at all.
    for (const literal of ["/apps", "/apps/system", "/apps/system/:keyword", "/apps/frames", "/apps/frames/:frameId", "/photos"]) {
      expect(routes[literal], literal).toBe(literal === "/photos" ? "photosWorkspace" : "appsWorkspace");
    }
    expect(paths.indexOf("/frames/:frameId/scenes/:sceneId")).toBeLessThan(paths.indexOf("/frames/:id/:tool"));
    // The settings pages live outside the mount, so they cannot collide
    // with a frame route at all.
    expect(routes["/account"]).toBe("settings");
    expect(routes["/account/:page"]).toBe("settings");
  });

  it("rewrites the pre-2026.8 doubled-segment URLs", () => {
    expect(legacyCloudPathRedirect("/frames/frames/abc")).toBe("/frames/abc");
    expect(legacyCloudPathRedirect("/frames/scenes/abc/def")).toBe("/frames/abc/scenes/def");
    expect(legacyCloudPathRedirect("/frames/scenes/abc")).toBe("/frames/abc/scenes");
    expect(legacyCloudPathRedirect("/frames/abc")).toBeNull();
    expect(legacyCloudPathRedirect("/account/developer")).toBeNull();
    // Until 2026.10 the apps and photos pages sat under the mount.
    expect(legacyCloudPathRedirect("/frames/photos")).toBe("/photos");
    expect(legacyCloudPathRedirect("/frames/apps")).toBe("/apps");
    expect(legacyCloudPathRedirect("/frames/apps/system")).toBe("/apps/system");
    expect(legacyCloudPathRedirect("/frames/apps/system/data%2Fclock")).toBe("/apps/system/data%2Fclock");
    expect(legacyCloudPathRedirect("/frames/apps/abc")).toBe("/apps/frames/abc");
    expect(legacyCloudPathRedirect("/frames/apps/abc/scene/node")).toBe("/apps/frames/abc/scene/node");
    expect(legacyCloudPathRedirect("/apps/system/x")).toBeNull();
    expect(legacyCloudPathRedirect("/photos")).toBeNull();
  });

  // kea-router takes the first pattern that matches. With frames at
  // /frames/:id, the literal /frames/scenes route has to be registered
  // before it or it renders as a frame named "scenes". The apps and photos
  // pages live beside the mount (/apps/…, /photos) in both route tables.
  it("registers the literal /frames/* routes before /frames/:id", async () => {
    const scenesModulePath = "@frameos/cloud-frontend/src/scenes/scenes";
    const { getRoutes } = (await import(scenesModulePath)) as {
      getRoutes: () => Record<string, string>;
    };
    const routes = withCloudSpaConfig(() => getRoutes());
    const paths = Object.keys(routes);
    const frameIndex = paths.indexOf("/frames/:id");
    expect(frameIndex).toBeGreaterThan(-1);
    expect(paths.indexOf("/frames/scenes")).toBeGreaterThan(-1);
    expect(paths.indexOf("/frames/scenes")).toBeLessThan(frameIndex);
    expect(paths).toContain("/frames/:frameId/scenes/:sceneId");
    for (const literal of ["/apps", "/apps/system", "/apps/system/:keyword", "/apps/frames", "/apps/frames/:frameId", "/apps/frames/:frameId/:sceneId/:nodeId"]) {
      expect(routes[literal], literal).toBe("appsWorkspace");
    }
    expect(routes["/photos"]).toBe("photosWorkspace");
    expect(paths.some((path) => path.startsWith("/frames/apps") || path === "/frames/photos")).toBe(false);
  });
});

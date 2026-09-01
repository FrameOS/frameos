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
import { urls } from "../../../../../../frontend/src/urls";

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

  // The global settings are an account page, not a SPA scene. The SPA links
  // out to the server-injected URL (it may be another origin, and shortens
  // on a split-host deployment) and falls back to the account path when the
  // shell was served without injection.
  it("links urls.settings() out to the account settings page", () => {
    expect(cloudSettingsUrl()).toBe("/account/settings");
    expect(cloudSettingsUrl()).toBe(withCloudSpaConfig(() => urls.settings()));
    (window as unknown as { FRAMEOS_APP_CONFIG?: unknown }).FRAMEOS_APP_CONFIG = {
      cloudMode: true,
      cloud_settings_url: "https://account.example/settings",
      route_base_path: cloudRouteBasePath,
    };
    expect(urls.settings()).toBe("https://account.example/settings");
  });

  it("has no settings scene in the cloud SPA any more", async () => {
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
    expect(Object.values(routes)).not.toContain("settings");
    expect(scenes).not.toHaveProperty("settings");
  });

  // The shared SPA has its OWN sceneLogic and route table
  // (frontend/src/scenes/scenes.tsx), and the workspace shell reads THAT one
  // to decide which rail button is pending — not the wrapper's. With
  // /frames/:id registered first it reported "frame" for /frames/apps, and
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
    for (const literal of ["/frames/apps", "/frames/apps/:frameId", "/frames/scenes", "/frames/:frameId/scenes"]) {
      expect(paths.indexOf(literal)).toBeGreaterThan(-1);
      expect(paths.indexOf(literal)).toBeLessThan(frameIndex);
    }
    expect(paths.indexOf("/frames/:frameId/scenes/:sceneId")).toBeLessThan(paths.indexOf("/frames/:id/:tool"));
    // Not registered on the cloud at all: it would be "/account/settings",
    // which is not under the SPA's mount.
    expect(Object.values(routes)).not.toContain("settings");
  });

  it("rewrites the pre-2026.8 doubled-segment URLs", () => {
    expect(legacyCloudPathRedirect("/frames/frames/abc")).toBe("/frames/abc");
    expect(legacyCloudPathRedirect("/frames/scenes/abc/def")).toBe("/frames/abc/scenes/def");
    expect(legacyCloudPathRedirect("/frames/scenes/abc")).toBe("/frames/abc/scenes");
    expect(legacyCloudPathRedirect("/frames/abc")).toBeNull();
    expect(legacyCloudPathRedirect("/frames/apps/system/x")).toBeNull();
    // /frames/settings is redirected server-side by the [[...path]] route.
    expect(legacyCloudPathRedirect("/frames/settings")).toBeNull();
  });

  // kea-router takes the first pattern that matches. With frames at
  // /frames/:id, the literal /frames/settings and /frames/apps routes have
  // to be registered before it or they render as a frame named "settings".
  it("registers the literal /frames/* routes before /frames/:id", async () => {
    const scenesModulePath = "@frameos/cloud-frontend/src/scenes/scenes";
    const { getRoutes } = (await import(scenesModulePath)) as {
      getRoutes: () => Record<string, string>;
    };
    const paths = Object.keys(withCloudSpaConfig(() => getRoutes()));
    const frameIndex = paths.indexOf("/frames/:id");
    expect(frameIndex).toBeGreaterThan(-1);
    for (const literal of ["/frames/apps", "/frames/apps/:frameId", "/frames/scenes"]) {
      expect(paths.indexOf(literal)).toBeGreaterThan(-1);
      expect(paths.indexOf(literal)).toBeLessThan(frameIndex);
    }
    expect(paths).toContain("/frames/:frameId/scenes/:sceneId");
  });
});

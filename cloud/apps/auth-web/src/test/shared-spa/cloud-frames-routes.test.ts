// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  cloudAssetsBasePath,
  cloudFrameUrl,
  cloudFramesUrl,
  cloudRouteBasePath,
  cloudSettingsUrl,
} from "@frameos/cloud-frontend/src/routes";
import { urls } from "../../../../../../frontend/src/urls";

// The fleet table (app/account/frames/page.tsx) is a Next.js server component
// linking INTO the SPA. It used to hand-build `/frames/${id}`, but the SPA
// mounts at /frames AND registers its own /frames/:id route, so the real path
// is /frames/frames/:id — every frame name in the table rendered the SPA's
// error404. It now uses cloud-frontend/src/routes.ts; this test is what keeps
// that helper honest, because the Next.js side cannot call `urls.frame()`
// itself (it reads window.FRAMEOS_APP_CONFIG, absent during SSR).

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

  it("produces the doubled segment the SPA route table registers", () => {
    expect(cloudFrameUrl("abc")).toBe("/frames/frames/abc");
    // The bug: a hand-built "/frames/${id}" is the frames LIST route plus a
    // stray segment, which the SPA renders as error404.
    expect(cloudFrameUrl("abc")).not.toBe("/frames/abc");
  });

  it("passes the tool query through the same way urls.frame does", () => {
    const fromSpa = withCloudSpaConfig(() => urls.frame("abc", "settings"));
    expect(cloudFrameUrl("abc", "settings")).toBe(fromSpa);
  });

  it("agrees with the SPA's own urls.settings()", () => {
    expect(cloudSettingsUrl()).toBe("/frames/settings");
    expect(cloudSettingsUrl()).toBe(withCloudSpaConfig(() => urls.settings()));
  });

  it("registers the account settings scene at /frames/settings", async () => {
    // The page 404'd client-side before the scene was registered: urls
    // helpers linked to /frames/settings but the SPA's route table had no
    // entry. The specifier is a variable ON PURPOSE: scenes.tsx transitively
    // imports the whole React SPA, and a static (or literal-dynamic) import
    // would drag all of it into this app's stricter tsc program — vitest
    // resolves the runtime import fine either way.
    const scenesModulePath = "@frameos/cloud-frontend/src/scenes/scenes";
    const { getRoutes, scenes } = (await import(scenesModulePath)) as {
      getRoutes: () => Record<string, string>;
      scenes: Record<string, unknown>;
    };
    const routes = withCloudSpaConfig(() => getRoutes());
    expect(routes[cloudSettingsUrl()]).toBe("settings");
    expect(scenes).toHaveProperty("settings");
  });
});

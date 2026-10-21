// @vitest-environment jsdom
// The home page behind the rail's logo is shared: the cloud's /home and a
// backend's /home (under its ingress path), never the on-device admin panel,
// whose logo is its one frame. A backend's frames carry last_log_at where a
// cloud frame has the hub's last_seen_at, so "recent" has to read both, and
// its numbers at a glance leave archived frames out.
import { afterEach, describe, expect, it } from "vitest";
import { urls } from "../../../../../../frontend/src/urls";
import {
  greetingNameOf,
  recentFramesOf,
} from "../../../../../../frontend/src/scenes/home/homeLogic";
import { backendGlanceOf } from "../../../../../../frontend/src/scenes/home/backendHomeLogic";
import type { FrameType } from "../../../../../../frontend/src/types";

function withSpaConfig<T>(config: Record<string, unknown>, run: () => T): T {
  (window as unknown as { FRAMEOS_APP_CONFIG?: unknown }).FRAMEOS_APP_CONFIG =
    config;
  return run();
}

afterEach(() => {
  delete (window as unknown as { FRAMEOS_APP_CONFIG?: unknown })
    .FRAMEOS_APP_CONFIG;
});

async function routesUnder(
  config: Record<string, unknown>,
): Promise<Record<string, string>> {
  // Through a variable, like cloud-frames-routes.test.ts: the module pulls
  // in every scene's types.
  const scenesModulePath = new URL(
    "../../../../../../frontend/src/scenes/scenes.tsx",
    import.meta.url,
  ).pathname;
  const { getRoutes } = (await import(scenesModulePath)) as {
    getRoutes: () => Record<string, string>;
  };
  return withSpaConfig(config, () => getRoutes());
}

const minutesAgo = (minutes: number) =>
  new Date(Date.now() - minutes * 60_000).toISOString();

function frame(id: number, fields: Partial<FrameType>): FrameType {
  return { id, name: `Frame ${id}`, ...fields } as FrameType;
}

describe("the home page's address", () => {
  it("is /home on a backend, beside the frames home at /", async () => {
    expect(withSpaConfig({}, () => urls.home())).toBe("/home");
    const routes = await routesUnder({});
    expect(routes["/home"]).toBe("home");
    expect(routes["/"]).toBe("frames");
  });

  it("sits under Home Assistant's ingress path", async () => {
    const config = { ingress_path: "/api/hassio_ingress/abc" };
    expect(withSpaConfig(config, () => urls.home())).toBe(
      "/api/hassio_ingress/abc/home",
    );
    expect((await routesUnder(config))["/api/hassio_ingress/abc/home"]).toBe(
      "home",
    );
  });

  it("is /home on the cloud", async () => {
    const config = {
      cloudMode: true,
      cloud_signed_in: true,
      route_base_path: "/frames",
    };
    expect(withSpaConfig(config, () => urls.home())).toBe("/home");
    expect((await routesUnder(config))["/home"]).toBe("home");
  });

  it("does not exist on the on-device admin panel", async () => {
    const config = { frameAdminMode: true };
    expect(withSpaConfig(config, () => urls.home())).toBe("/admin");
    expect(Object.values(await routesUnder(config))).not.toContain("home");
  });
});

describe("the home page's frames", () => {
  it("puts the most recently heard from first, backend and cloud alike", () => {
    const recent = recentFramesOf([
      frame(1, { last_log_at: minutesAgo(90) }),
      frame(2, { last_seen_at: minutesAgo(1) }),
      frame(3, { last_log_at: minutesAgo(5) }),
      frame(4, {}),
    ]);
    expect(recent.map((f) => f.id)).toEqual([2, 3, 1, 4]);
  });

  it("puts archived frames last, however recent", () => {
    const recent = recentFramesOf([
      frame(1, { last_log_at: minutesAgo(1), archived: true }),
      frame(2, { last_log_at: minutesAgo(60) }),
    ]);
    expect(recent.map((f) => f.id)).toEqual([2, 1]);
  });
});

describe("a backend's numbers at a glance", () => {
  it("counts frames, active frames and installed scenes, archived ones aside", () => {
    const scene = { id: "s", name: "S", nodes: [], edges: [] };
    expect(
      backendGlanceOf([
        frame(1, { status: "ready", last_log_at: minutesAgo(1), scenes: [scene, scene] } as Partial<FrameType>),
        frame(2, { status: "uninitialized", scenes: [] } as Partial<FrameType>),
        frame(3, { archived: true, scenes: [scene] } as Partial<FrameType>),
      ]),
    ).toEqual({ frames: 2, activeFrames: 1, installedScenes: 2, framesWithScenes: 1 });
  });
});

describe("the greeting", () => {
  it("uses the name, else the address before its @", () => {
    expect(greetingNameOf(" Ada ", "ada@example.com")).toBe("Ada");
    expect(greetingNameOf(null, "ada@example.com")).toBe("ada");
    expect(greetingNameOf(null, undefined)).toBe("");
  });
});

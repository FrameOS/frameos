import { describe, expect, it } from "vitest";
import { cloudRenderedPlatformPrefixes, hardwareIsCloudRendered } from "./cloud-rendered";
import { virtualViewPage } from "./virtual-frame-http";
import {
  hardwareIsVirtual,
  isVirtualViewToken,
  newVirtualViewToken,
  publicSceneState,
  sceneRefreshSeconds,
  storableSceneState,
  virtualFrameSize,
  virtualHardware,
  virtualRenderIntervalSeconds,
  virtualSizeError,
} from "./virtual-frames";

describe("a virtual frame's size", () => {
  it("takes whole pixels the renderer can draw", () => {
    expect(virtualSizeError(800, 480)).toBeUndefined();
    expect(virtualSizeError(16, 16)).toBeUndefined();
    expect(virtualSizeError(15, 480)).toBe("invalid_size");
    expect(virtualSizeError(800.5, 480)).toBe("invalid_size");
    expect(virtualSizeError("800", 480)).toBe("invalid_size");
    expect(virtualSizeError(4097, 480)).toBe("invalid_size");
    // Each edge is fine; together they are more than one render may hold.
    expect(virtualSizeError(4096, 4096)).toBe("size_too_large");
  });

  it("reports itself the way a frame's hello does", () => {
    const hardware = virtualHardware(1920, 1080);
    expect(hardware).toMatchObject({ device: "virtual", height: 1080, platform: "virtual", width: 1920 });
    expect(hardwareIsVirtual(hardware)).toBe(true);
    expect(virtualFrameSize(hardware)).toEqual({ height: 1080, width: 1920 });
    // A row that lost its size draws at the default instead of failing.
    expect(virtualFrameSize({ platform: "virtual" })).toEqual({ height: 480, width: 800 });
    expect(hardwareIsVirtual({ platform: "esp32-s3" })).toBe(false);
    expect(hardwareIsVirtual(null)).toBe(false);
  });

  it("counts against the plan's cloud-rendered frames", () => {
    expect(cloudRenderedPlatformPrefixes).toContain("virtual");
    expect(hardwareIsCloudRendered(virtualHardware(800, 480))).toBe(true);
    expect(hardwareIsCloudRendered({ platform: "rpios" })).toBe(false);
  });
});

describe("the view link", () => {
  it("is a secret nobody could guess, in one shape", () => {
    const token = newVirtualViewToken();
    expect(token).toMatch(/^vf_[A-Za-z0-9_-]{32}$/);
    expect(newVirtualViewToken()).not.toBe(token);
    expect(isVirtualViewToken(token)).toBe(true);
    expect(isVirtualViewToken("vf_short")).toBe(false);
    expect(isVirtualViewToken(`${token}/../x`)).toBe(false);
    expect(isVirtualViewToken(undefined)).toBe(false);
  });

  it("draws the frame's name as text, never as markup", () => {
    const page = virtualViewPage({
      height: 480,
      name: `</title><script>alert("x")</script>`,
      token: "vf_0123456789abcdef0123456789abcdef",
      version: null,
      width: 800,
    });
    expect(page).not.toContain("<script>alert");
    expect(page).toContain("&lt;/title&gt;&lt;script&gt;");
    // Nothing drawn yet: no picture is asked for, and the page says so.
    expect(page).toContain('<img id="frame" width="800" height="480" alt="" hidden>');
    expect(page).toContain("has not drawn anything yet");
    const drawn = virtualViewPage({
      height: 480,
      name: "Lobby",
      token: "vf_0123456789abcdef0123456789abcdef",
      version: "abc123",
      width: 800,
    });
    expect(drawn).toContain('src="/v/vf_0123456789abcdef0123456789abcdef/image?v=abc123"');
  });
});

describe("the scene's refresh interval", () => {
  it("follows the rule every runtime follows", () => {
    // The scene's settings, as an implicit state key.
    expect(sceneRefreshSeconds({ settings: { refreshInterval: 900 } }, {})).toBe(900);
    expect(sceneRefreshSeconds({ settings: { refreshInterval: 900 } }, { refreshInterval: 60 })).toBe(60);
    // A field with the role wins, wherever it is and whatever it is called.
    const withRole = {
      fields: [
        { name: "refreshInterval", type: "string", value: "soon" },
        { name: "every", role: "refreshInterval", type: "float", value: "120" },
      ],
      settings: { refreshInterval: 900 },
    };
    expect(sceneRefreshSeconds(withRole, {})).toBe(120);
    expect(sceneRefreshSeconds(withRole, { every: 45 })).toBe(45);
    // A numeric field of the name.
    expect(sceneRefreshSeconds({ fields: [{ name: "refreshInterval", type: "integer", value: "30" }] }, {})).toBe(30);
    // The name used for something else: the settings alone decide.
    const taken = { fields: [{ name: "refreshInterval", type: "string" }], settings: { refreshInterval: 600 } };
    expect(sceneRefreshSeconds(taken, { refreshInterval: "whenever" })).toBe(600);
    // Nothing said anywhere.
    expect(sceneRefreshSeconds({}, {})).toBeNull();
    expect(sceneRefreshSeconds({ settings: { refreshInterval: -5 } }, { refreshInterval: "x" })).toBeNull();
  });

  it("never renders more often than the plan allows", () => {
    const floor = 300;
    expect(virtualRenderIntervalSeconds({ frameIntervalSeconds: 60, minIntervalSeconds: floor, sceneRefreshSeconds: null })).toBe(300);
    expect(virtualRenderIntervalSeconds({ frameIntervalSeconds: 60, minIntervalSeconds: floor, sceneRefreshSeconds: 10 })).toBe(300);
    expect(virtualRenderIntervalSeconds({ frameIntervalSeconds: 60, minIntervalSeconds: floor, sceneRefreshSeconds: 3600 })).toBe(3600);
    expect(virtualRenderIntervalSeconds({ frameIntervalSeconds: 900, minIntervalSeconds: floor, sceneRefreshSeconds: null })).toBe(900);
    expect(virtualRenderIntervalSeconds({ frameIntervalSeconds: undefined, minIntervalSeconds: 60, sceneRefreshSeconds: undefined })).toBe(300);
  });
});

describe("scene state between renders", () => {
  const scene = {
    fields: [
      { name: "city", type: "string" },
      { access: "private", name: "cursor", type: "integer" },
      { access: "private", name: "page", persist: "disk", type: "integer" },
      { name: "options", type: "json" },
    ],
  };

  it("takes only what a scene takes from outside", () => {
    expect(
      publicSceneState(scene, { city: "Tartu", cursor: 9, nope: true, options: '{"a":1}', page: 3, refreshInterval: 600 }),
    ).toEqual({ city: "Tartu", options: { a: 1 }, refreshInterval: 600 });
    // Text that is not JSON stays the text it came as.
    expect(publicSceneState(scene, { options: "{oops" })).toEqual({ options: "{oops" });
    expect(publicSceneState(scene, "not an object")).toEqual({});
  });

  it("keeps what a device would keep across a restart", () => {
    expect(
      storableSceneState(scene, { city: "Tartu", cursor: 9, extra: 1, options: { a: 1 }, page: 3, refreshInterval: 600 }),
    ).toEqual({ city: "Tartu", options: { a: 1 }, page: 3, refreshInterval: 600 });
  });
});

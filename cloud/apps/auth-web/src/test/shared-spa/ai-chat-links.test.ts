// @vitest-environment jsdom
//
// The AI chat names frames and scenes as frameos:// links (docs/ai-chat.md
// "Links"): it knows their ids, not where the pages are, which differs per
// control plane (the cloud mounts the SPA at /frames, a backend may sit
// under an ingress path). They came out as bold names nobody could click.
// The chat turns them into the page they stand for; an id is only ever
// encoded into a path, so a crafted one cannot name another route. How the
// chat's markdown renders them: markdown-safety.test.tsx.

import { afterEach, describe, expect, it } from "vitest";
import { chatLinkPath, chatLinkRoute, parseChatLink } from "../../../../../../frontend/src/utils/chatLinks";

type TestWindow = Window & { FRAMEOS_APP_CONFIG?: Record<string, unknown> };
const testWindow = window as TestWindow;

afterEach(() => {
  delete testWindow.FRAMEOS_APP_CONFIG;
});

describe("parseChatLink", () => {
  it("reads a frame and a scene on a frame", () => {
    expect(parseChatLink("frameos://frame/12")).toEqual({ frameId: "12", sceneId: null });
    expect(parseChatLink("frameos://frame/0b6c3e9a-1d2f-4c8e-9a7b-5e4d3c2b1a00/scene/clock-1")).toEqual({
      frameId: "0b6c3e9a-1d2f-4c8e-9a7b-5e4d3c2b1a00",
      sceneId: "clock-1",
    });
    expect(parseChatLink("frameos://frame/12/scene/my%20scene")).toEqual({ frameId: "12", sceneId: "my scene" });
  });

  it("is null for anything else", () => {
    for (const href of [
      "https://example.com/frames/12",
      "/frames/12",
      "frameos://frame/",
      "frameos://frame/12/scene/",
      "frameos://frame/12/logs",
      "frameos://store/abc",
      "frameos://frame/%E0%A4%A",
    ]) {
      expect(parseChatLink(href), href).toBeNull();
    }
  });
});

describe("chatLinkRoute", () => {
  it("is the frame's page, or its scene drawer, on a backend", () => {
    expect(chatLinkRoute("frameos://frame/12")).toBe("/frames/12");
    expect(chatLinkRoute("frameos://frame/12/scene/clock-1")).toBe("/frames/12?drawer=scene&sceneId=clock-1");
  });

  it("follows the ingress path and the cloud's /frames mount", () => {
    testWindow.FRAMEOS_APP_CONFIG = { ingress_path: "/api/hassio_ingress/abc" };
    expect(chatLinkRoute("frameos://frame/12")).toBe("/api/hassio_ingress/abc/frames/12");
    testWindow.FRAMEOS_APP_CONFIG = { cloudMode: true, route_base_path: "/frames" };
    expect(chatLinkRoute("frameos://frame/b3f1/scene/s-1")).toBe("/frames/b3f1?drawer=scene&sceneId=s-1");
  });

  it("encodes an id instead of letting it name another route", () => {
    expect(chatLinkRoute("frameos://frame/..%2Fsettings")).toBe("/frames/..%2Fsettings");
    expect(chatLinkPath({ frameId: "a/b", sceneId: "x&drawer=deployPlan" }, (id) => `/f/${id}`)).toBe(
      "/f/a%2Fb?drawer=scene&sceneId=x%26drawer%3DdeployPlan",
    );
  });
});

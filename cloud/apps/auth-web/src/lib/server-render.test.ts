import { describe, expect, it } from "vitest";
import { frameIsCloudRendered, settingsRenderOnServer } from "./cloud-rendered";
import {
  candidateServerRenderScene,
  chooseServerRenderScene,
  ifNoneMatchHas,
  lastPictureUsable,
  parseServerRenderPanel,
  prerenderLeadMs,
  prerenderUsable,
  serverRenderEtag,
  serverRenderPanelKey,
} from "./server-render";

const scenes = [
  { id: "layout", settings: { isLayout: true } },
  { id: "clock" },
  { default: true, id: "photos" },
  { id: "weather" },
];

describe("which frames the cloud renders for", () => {
  it("a board set to remote, a board without a runtime, a virtual frame", () => {
    expect(settingsRenderOnServer({ render_mode: "remote" })).toBe(true);
    expect(settingsRenderOnServer({ render_mode: "local" })).toBe(false);
    expect(settingsRenderOnServer(null)).toBe(false);
    expect(frameIsCloudRendered({ hardware: { platform: "esp32-s3" }, settings: { render_mode: "remote" } })).toBe(true);
    expect(frameIsCloudRendered({ hardware: { platform: "esp32-s3" }, settings: {} })).toBe(false);
    expect(frameIsCloudRendered({ hardware: { platform: "esp32-c3" }, settings: {} })).toBe(true);
    // The device's word is not the plane's setting.
    expect(frameIsCloudRendered({ hardware: { platform: "esp32-s3", renderMode: "remote" }, settings: {} })).toBe(false);
  });
});

describe("which scene a pull draws", () => {
  it("a switch the device has not taken wins", () => {
    expect(
      chooseServerRenderScene({ activeScene: "weather", deviceScene: "clock", pendingSwitch: true, scenes }),
    ).toBe("weather");
  });

  it("then the device's own scene: a key, a touch, its schedule", () => {
    expect(
      chooseServerRenderScene({ activeScene: "weather", deviceScene: "clock", pendingSwitch: false, scenes }),
    ).toBe("clock");
  });

  it("then the plane's, then the default, then the first scene that is not a layout", () => {
    expect(chooseServerRenderScene({ activeScene: "weather", deviceScene: "gone", pendingSwitch: false, scenes })).toBe(
      "weather",
    );
    expect(chooseServerRenderScene({ activeScene: null, deviceScene: undefined, pendingSwitch: false, scenes })).toBe(
      "photos",
    );
    expect(
      chooseServerRenderScene({ activeScene: null, deviceScene: undefined, pendingSwitch: false, scenes: [scenes[0]!, scenes[1]!] }),
    ).toBe("clock");
  });

  it("never draws a layout as the scene", () => {
    expect(chooseServerRenderScene({ activeScene: "layout", deviceScene: "layout", pendingSwitch: true, scenes })).toBe(
      "photos",
    );
    expect(
      chooseServerRenderScene({ activeScene: null, deviceScene: null, pendingSwitch: false, scenes: [scenes[0]!] }),
    ).toBeUndefined();
  });

  it("asks a kept picture about the same scene before the bundle is open", () => {
    expect(candidateServerRenderScene({ activeScene: "weather", deviceScene: "clock", pendingSwitch: true })).toBe("weather");
    expect(candidateServerRenderScene({ activeScene: "weather", deviceScene: "clock", pendingSwitch: false })).toBe("clock");
    expect(candidateServerRenderScene({ activeScene: "weather", deviceScene: undefined, pendingSwitch: false })).toBe("weather");
  });
});

describe("the pull's panel", () => {
  it("reads width, height, format and rotation", () => {
    const panel = parseServerRenderPanel(new URLSearchParams("width=1200&height=1600&format=7&rotate=90"));
    expect(panel).toEqual({ format: 7, height: 1600, rotate: 90, width: 1200 });
    expect(serverRenderPanelKey(panel!)).toBe("1200x1600/7/90");
    expect(parseServerRenderPanel(new URLSearchParams("width=800&height=480&format=1"))?.rotate).toBe(0);
  });

  it("refuses what is not a panel", () => {
    for (const query of [
      "height=480&format=1",
      "width=800&height=480",
      "width=800&height=480&format=12",
      "width=800&height=480&format=1&rotate=45",
      "width=8&height=480&format=1",
      "width=4097&height=480&format=1",
      "width=4000&height=4000&format=1",
      "width=-800&height=480&format=1",
      "width=800.5&height=480&format=1",
    ]) {
      expect(parseServerRenderPanel(new URLSearchParams(query)), query).toBeNull();
    }
  });
});

describe("ETags", () => {
  it("are the first 32 hex digits of the body's sha256", () => {
    expect(serverRenderEtag(Buffer.from("FOSB"))).toMatch(/^[0-9a-f]{32}$/);
    expect(serverRenderEtag(Buffer.from("a"))).not.toBe(serverRenderEtag(Buffer.from("b")));
  });

  it("match If-None-Match quoted, weak or in a list", () => {
    expect(ifNoneMatchHas('"abc"', "abc")).toBe(true);
    expect(ifNoneMatchHas("abc", "abc")).toBe(true);
    expect(ifNoneMatchHas('W/"abc"', "abc")).toBe(true);
    expect(ifNoneMatchHas('"x", "abc"', "abc")).toBe(true);
    expect(ifNoneMatchHas('"x"', "abc")).toBe(false);
    expect(ifNoneMatchHas(null, "abc")).toBe(false);
    expect(ifNoneMatchHas('"abc"', null)).toBe(false);
  });
});

describe("kept pictures", () => {
  const now = new Date("2026-11-12T12:00:00Z");
  const picture = {
    picture: Buffer.from("FOSB"),
    picturePanel: "800x480/1/0",
    pictureRevision: 3,
    pictureScene: "clock",
    renderedAt: new Date(now.getTime() - 60_000),
    revision: 3,
  };

  it("hand the last picture out again inside the floor, while nothing moved", () => {
    const input = { floorSeconds: 300, now, panelKey: "800x480/1/0", scene: "clock" };
    expect(lastPictureUsable(picture, input)).toBe(true);
    expect(lastPictureUsable({ ...picture, revision: 4 }, input)).toBe(false);
    expect(lastPictureUsable(picture, { ...input, scene: "weather" })).toBe(false);
    expect(lastPictureUsable(picture, { ...input, panelKey: "800x480/1/90" })).toBe(false);
    expect(lastPictureUsable(picture, { ...input, floorSeconds: 30 })).toBe(false);
    expect(lastPictureUsable({ ...picture, picture: null }, input)).toBe(false);
  });

  const prerender = {
    pendingEvents: [],
    prerender: Buffer.from("FOSB"),
    prerenderAsOf: new Date(now.getTime() + 30_000),
    prerenderPanel: "800x480/1/0",
    prerenderRevision: 3,
    prerenderScene: "clock",
    revision: 3,
  };

  it("take a pre-render near its time, for the same scene, revision and panel, with no event waiting", () => {
    const input = { now, panelKey: "800x480/1/0", scene: "clock" };
    expect(prerenderUsable(prerender, input)).toBe(true);
    expect(prerenderUsable({ ...prerender, prerenderAsOf: new Date(now.getTime() - 121_000) }, input)).toBe(false);
    expect(prerenderUsable({ ...prerender, prerenderAsOf: new Date(now.getTime() + 121_000) }, input)).toBe(false);
    expect(prerenderUsable({ ...prerender, revision: 4 }, input)).toBe(false);
    expect(prerenderUsable(prerender, { ...input, scene: "weather" })).toBe(false);
    expect(prerenderUsable(prerender, { ...input, panelKey: "800x480/2/0" })).toBe(false);
    expect(prerenderUsable({ ...prerender, pendingEvents: [{ name: "button" }] }, input)).toBe(false);
  });

  it("start twice the last render plus 10 s before the wake, between 20 and 90 s", () => {
    expect(prerenderLeadMs(null)).toBe(20_000);
    expect(prerenderLeadMs(2_000)).toBe(20_000);
    expect(prerenderLeadMs(15_000)).toBe(40_000);
    expect(prerenderLeadMs(60_000)).toBe(90_000);
  });
});

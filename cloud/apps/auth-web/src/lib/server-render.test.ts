import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { frameIsCloudRendered, planeKeepsSceneState, settingsRenderOnServer } from "./cloud-rendered";
import {
  builtInSceneIds,
  candidateServerRenderScene,
  chooseServerRenderScene,
  deviceInputHasAny,
  ifNoneMatchHas,
  lastPictureUsable,
  maxKeptStateBytes,
  maxNextRenderSeconds,
  parseServerRenderPanel,
  planeLastState,
  prerenderLeadMs,
  prerenderUsable,
  readDeviceInput,
  relayedEventOrigins,
  renderFrameConfig,
  serverNextRenderSeconds,
  serverRenderEtag,
  serverRenderPanelKey,
  storedKeptState,
} from "./server-render";

const eventsContract = JSON.parse(
  readFileSync(join(__dirname, "../../../../../docs/events-contract.json"), "utf8"),
) as { origins: Record<string, string>; scenes: { settings: string; switcher: string } };

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

describe("a built-in scene a render ended on", () => {
  it("names the contract's switcher and scene settings", () => {
    expect([...builtInSceneIds].sort()).toEqual([eventsContract.scenes.settings, eventsContract.scenes.switcher].sort());
  });

  it("is the plane's scene until something else is", () => {
    expect(
      chooseServerRenderScene({ activeScene: "system/sceneSwitcher", deviceScene: undefined, pendingSwitch: false, scenes }),
    ).toBe("system/sceneSwitcher");
    // A switch the plane sent the device still wins over it.
    expect(
      chooseServerRenderScene({ activeScene: "system/sceneSettings", deviceScene: undefined, pendingSwitch: true, scenes }),
    ).toBe("system/sceneSettings");
    // Any other id outside the list is not.
    expect(chooseServerRenderScene({ activeScene: "system/yield", deviceScene: undefined, pendingSwitch: false, scenes })).toBe(
      "photos",
    );
  });
});

describe("the input a device relays with its pull", () => {
  const edge = { action: "down", atMs: 900, label: "RIGHT", pin: 3 };
  const event = { name: "setCurrentScene", origin: "schedule", payload: { sceneId: "news" } };

  it("relays from the device's own origins only", () => {
    for (const origin of relayedEventOrigins) {
      expect(eventsContract.origins[origin]).toBeDefined();
    }
    expect([...relayedEventOrigins].sort()).toEqual(["driver", "http:admin", "http:write", "schedule"]);
  });

  it("keeps edges and events that say something, oldest first", () => {
    const input = readDeviceInput({
      edges: [edge, { ...edge, action: "up", atMs: 950, claimed: true, wake: true }],
      events: [
        event,
        { name: "gpio", origin: "driver", payload: { action: "down", atMs: 10, label: "LEFT", level: 0, pin: 2 } },
        { name: "pointerDown", origin: "driver" },
      ],
      nowMs: 1000,
    });
    expect(input).toEqual({
      edges: [
        { action: "down", atMs: 900, label: "RIGHT", pin: 3 },
        { action: "up", atMs: 950, claimed: true, label: "RIGHT", pin: 3, wake: true },
      ],
      events: [
        event,
        { name: "gpio", origin: "driver", payload: { action: "down", atMs: 10, label: "LEFT", level: 0, pin: 2 } },
        { name: "pointerDown", origin: "driver", payload: {} },
      ],
      nowMs: 1000,
    });
    expect(deviceInputHasAny(input)).toBe(true);
    expect(deviceInputHasAny(readDeviceInput({ nowMs: 5 }))).toBe(false);
  });

  it("drops what it cannot use, and what came from another origin", () => {
    const input = readDeviceInput({
      edges: [
        { ...edge, label: "with space" },
        { ...edge, action: "held" },
        { ...edge, atMs: 2000 },
        { ...edge, atMs: -1 },
        "RIGHT",
      ],
      events: [
        { ...event, origin: "cloud" },
        { ...event, origin: "system" },
        { ...event, name: "" },
        { ...event, name: "x".repeat(65) },
        { ...event, payload: "news" },
        { ...event, payload: [] },
      ],
      nowMs: 1000,
    });
    expect(input).toEqual({ edges: [], events: [], nowMs: 1000 });
  });

  it("keeps 32 of each", () => {
    const input = readDeviceInput({
      edges: Array.from({ length: 40 }, () => edge),
      events: Array.from({ length: 40 }, () => event),
      nowMs: 1000,
    });
    expect(input?.edges).toHaveLength(32);
    expect(input?.events).toHaveLength(32);
  });

  it("refuses a body of another shape", () => {
    expect(readDeviceInput(null)).toBeNull();
    expect(readDeviceInput([])).toBeNull();
    expect(readDeviceInput({ edges: [] })).toBeNull();
    expect(readDeviceInput({ nowMs: 1.5 })).toBeNull();
    expect(readDeviceInput({ nowMs: "1000" })).toBeNull();
    expect(readDeviceInput({ edges: {}, nowMs: 1000 })).toBeNull();
    expect(readDeviceInput({ events: "gpio", nowMs: 1000 })).toBeNull();
  });
});

describe("what the render is told of its frame", () => {
  it("the plane's event map, else the one the device runs; the palette's colours; the colours block", () => {
    const rules = [{ as: { direction: "prev", event: "setCurrentScene" }, event: "longPress", match: { label: "LEFT" } }];
    const preset = [{ as: { direction: "next", event: "setCurrentScene" }, event: "longPress", match: { label: "RIGHT" } }];
    expect(
      renderFrameConfig({
        hardware: { eventMap: preset },
        settings: {
          colors: { autoFit: "on" },
          event_map: rules,
          palette: { colors: ["#000000", "#ffffff"], name: "Mine" },
        },
      }),
    ).toEqual({ colors: { autoFit: "on" }, eventMap: rules, palette: ["#000000", "#ffffff"] });
    expect(renderFrameConfig({ hardware: { eventMap: preset }, settings: {} })).toEqual({ eventMap: preset });
    expect(renderFrameConfig({ hardware: null, settings: null })).toEqual({});
  });
});

describe("the frame's reported scene, for hardware the cloud renders for", () => {
  it("is the plane's, not the device's; a virtual frame's device is its runtime", () => {
    expect(planeKeepsSceneState({ hardware: { platform: "esp32-s3" }, settings: { render_mode: "remote" } })).toBe(true);
    expect(planeKeepsSceneState({ hardware: { platform: "esp32-c3" }, settings: {} })).toBe(true);
    expect(planeKeepsSceneState({ hardware: { platform: "esp32-s3" }, settings: {} })).toBe(false);
    expect(planeKeepsSceneState({ hardware: { platform: "virtual" }, settings: {} })).toBe(false);
  });

  it("is written as a device reports it: the frame's scenes' states and active_scene", () => {
    expect(planeLastState("weather", { clock: { count: 1 }, weather: { title: "Hi" } })).toEqual({
      active_scene: "weather",
      clock: { count: 1 },
      weather: { title: "Hi" },
    });
    // While the switcher shows, the frame's scene is the one it was opened over.
    expect(
      planeLastState("system/sceneSwitcher", { clock: { count: 1 }, "system/sceneSwitcher": { from: "clock" } }),
    ).toEqual({ active_scene: "clock", clock: { count: 1 } });
    expect(planeLastState(null, { clock: { count: 1 } })).toEqual({ clock: { count: 1 } });
  });
});

describe("when the next picture is due (docs/server-rendering.md)", () => {
  it("is the render's nextSleep before the scene's interval", () => {
    expect(serverNextRenderSeconds({ nextSleep: 900, refreshInterval: 600 }, 300)).toBe(900);
    expect(serverNextRenderSeconds({ refreshInterval: 600 }, 300)).toBe(600);
    expect(serverNextRenderSeconds({ nextSleep: -1, refreshInterval: 600 }, 300)).toBe(600);
  });

  it("is nothing when the scene has no opinion", () => {
    expect(serverNextRenderSeconds({}, 300)).toBeNull();
    expect(serverNextRenderSeconds({ nextSleep: -1, refreshInterval: 0 }, 300)).toBeNull();
    expect(serverNextRenderSeconds({ nextSleep: null, refreshInterval: Number.NaN }, 300)).toBeNull();
  });

  it("is never under the plan's floor, nor over seven days", () => {
    // A clock that wants every second, and a nextSleep of 0, wait the floor.
    expect(serverNextRenderSeconds({ refreshInterval: 1 }, 300)).toBe(300);
    expect(serverNextRenderSeconds({ nextSleep: 0, refreshInterval: 60 }, 300)).toBe(300);
    expect(serverNextRenderSeconds({ refreshInterval: 30 * 86400 }, 300)).toBe(maxNextRenderSeconds);
    expect(maxNextRenderSeconds).toBe(7 * 86400);
    // Whole seconds on the wire.
    expect(serverNextRenderSeconds({ refreshInterval: 450.4 }, 300)).toBe(450);
  });

  it("takes the plan's floor for cloud-rendered frames by default", () => {
    expect(serverNextRenderSeconds({ refreshInterval: 1 })).toBeGreaterThanOrEqual(1);
    expect(serverNextRenderSeconds({ refreshInterval: 1 })).toBe(serverNextRenderSeconds({ refreshInterval: 0.5 }));
  });
});

describe("what a render process keeps for the next pull (docs/server-rendering.md \"State and events\")", () => {
  const typing = JSON.stringify({
    apps: [{ memory: { draft: '{"name":"abc"}' }, nodeId: 4, sceneId: "form" }],
    targets: [{ caret: 3, focus: 2, keyboard: true, nodeId: 4, sceneId: "form", text: "abc" }],
  });

  it("is stored as the runtime wrote it, for the next pull", () => {
    expect(storedKeptState(typing)).toBe(typing);
  });

  it("leaves the stored one when the render said nothing", () => {
    expect(storedKeptState(undefined)).toBeUndefined();
    expect(storedKeptState(null)).toBeUndefined();
  });

  it("is nothing when nothing lasts, or it is not a JSON object", () => {
    expect(storedKeptState("{}")).toBeNull();
    expect(storedKeptState("[1]")).toBeNull();
    expect(storedKeptState("{")).toBeNull();
    expect(storedKeptState("")).toBeNull();
  });

  it("is dropped past 512 KiB, an ESP32's budget for one node's remembered values", () => {
    expect(maxKeptStateBytes).toBe(512 * 1024);
    const atCap = JSON.stringify({ pad: "x".repeat(maxKeptStateBytes - 10) });
    expect(Buffer.byteLength(atCap)).toBe(maxKeptStateBytes);
    expect(storedKeptState(atCap)).toBe(atCap);
    // Bytes, not characters.
    const over = JSON.stringify({ pad: "é".repeat(maxKeptStateBytes / 2) });
    expect(over.length).toBeLessThan(maxKeptStateBytes + 20);
    expect(storedKeptState(over)).toBeNull();
  });
});

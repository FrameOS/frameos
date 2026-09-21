import { describe, expect, it } from "vitest";
import {
  buttonEventCommand,
  cloudDeclaredCustomEvents,
  cloudEventRouting,
  cloudEventVerb,
  customEventRouting,
  maxSceneEventPayloadBytes,
  reportedActiveSceneId,
  sceneEventCommand,
  sceneStateCommand,
  sceneStateEventCommand,
} from "./frame-events";

describe("reportedActiveSceneId", () => {
  it("reads the scene the device last reported", () => {
    expect(
      reportedActiveSceneId({ active_scene: "uploaded/clock", "uploaded/clock": { city: "Tartu" } }),
    ).toBe("uploaded/clock");
  });

  it("is undefined when the frame has reported nothing usable", () => {
    expect(reportedActiveSceneId(null)).toBeUndefined();
    expect(reportedActiveSceneId([])).toBeUndefined();
    expect(reportedActiveSceneId({})).toBeUndefined();
    expect(reportedActiveSceneId({ active_scene: "" })).toBeUndefined();
    expect(reportedActiveSceneId({ active_scene: 7 })).toBeUndefined();
    expect(reportedActiveSceneId({ active_scene: "x".repeat(257) })).toBeUndefined();
  });
});

describe("sceneStateCommand", () => {
  const lastState = { active_scene: "uploaded/clock" };

  it("aims set_current_scene at the scene the frame is showing, state attached", () => {
    expect(
      sceneStateCommand({ lastState, profile: "linux", state: { city: "Tartu" } }),
    ).toEqual({
      ok: true,
      payload: { scene_id: "uploaded/clock", state: { city: "Tartu" } },
    });
  });

  it("refuses an esp32 frame, whose set_current_scene drops the state", () => {
    expect(
      sceneStateCommand({ lastState, profile: "esp32", state: { city: "Tartu" } }),
    ).toEqual({ error: "unsupported_event", ok: false, status: 404 });
  });

  it("refuses a missing (or oversized, which the route drops) state", () => {
    expect(sceneStateCommand({ lastState, profile: "linux", state: undefined })).toEqual({
      error: "invalid_state",
      ok: false,
      status: 400,
    });
  });

  it("refuses to guess a scene for a frame that has not reported one", () => {
    expect(
      sceneStateCommand({ lastState: {}, profile: "linux", state: { city: "Tartu" } }),
    ).toEqual({ error: "active_scene_unknown", ok: false, status: 409 });
  });
});

describe("cloudEventRouting", () => {
  it("sends a frame that knows scene_event the event itself", () => {
    expect(cloudEventVerb("setSceneState", "linux", "2026.9.21")).toEqual({ verb: "scene_event" });
    expect(cloudEventVerb("setSceneState", "esp32", "2026.9.21")).toEqual({ verb: "scene_event" });
    expect(cloudEventVerb("button", "esp32", "2026.10.1")).toEqual({ verb: "scene_event" });
  });

  it("keeps the older frame on what the event was before, where that worked", () => {
    expect(cloudEventVerb("setSceneState", "linux", "2026.9.20")).toEqual({ verb: "set_current_scene" });
    expect(cloudEventRouting("setSceneState", "esp32", "2026.9.20")).toEqual({
      error: "frame_update_required",
      minFrameosVersion: "2026.9.21",
      ok: false,
      status: 409,
    });
  });

  it("counts a frame that reported no version as an old one", () => {
    expect(cloudEventVerb("setSceneState", "linux", null)).toEqual({ verb: "set_current_scene" });
    expect(cloudEventVerb("setSceneState", "linux", "  ")).toEqual({ verb: "set_current_scene" });
    expect(cloudEventVerb("button", "linux")).toBeUndefined();
  });

  it("does not ask the version of an event whose verb has always been there", () => {
    expect(cloudEventVerb("render", "esp32", null)).toEqual({ verb: "render" });
    expect(cloudEventRouting("turnOn", "esp32", "2026.9.21")).toEqual({
      error: "unsupported_event",
      ok: false,
      status: 404,
    });
  });
});

describe("cloudDeclaredCustomEvents", () => {
  it("reads the declarations that list the cloud origin", () => {
    expect([
      ...cloudDeclaredCustomEvents([
        { name: "nextPage", origins: ["cloud"] },
        { name: "both", origins: ["schedule", "cloud"] },
        { name: "scheduled", origins: ["schedule"] },
        { name: "plain" },
        { name: "notAList", origins: "cloud" },
      ]),
    ]).toEqual(["nextPage", "both"]);
  });

  it("ignores what is not a declaration, and names that are the contract's", () => {
    expect(cloudDeclaredCustomEvents(undefined).size).toBe(0);
    expect(cloudDeclaredCustomEvents({ name: "nextPage", origins: ["cloud"] }).size).toBe(0);
    expect(
      cloudDeclaredCustomEvents([
        null,
        "nextPage",
        { name: "", origins: ["cloud"] },
        { name: "x".repeat(64), origins: ["cloud"] },
        { name: "reboot", origins: ["cloud"] },
        { name: 7, origins: ["cloud"] },
      ]).size,
    ).toBe(0);
  });
});

describe("customEventRouting", () => {
  const pager = { customEvents: [{ name: "nextPage", origins: ["cloud"] }], id: "pager" };
  const clock = { customEvents: [{ name: "chime", origins: ["cloud"] }], id: "clock" };
  const base = { frameosVersion: "2026.9.21", profile: "linux" as const, scenes: [pager, clock] };

  it("asks the scene the frame is showing, in either spelling of its id", () => {
    for (const activeSceneId of ["pager", "uploaded/pager"]) {
      expect(customEventRouting({ ...base, activeSceneId, eventName: "nextPage" })).toEqual({
        ok: true,
        verb: "scene_event",
      });
      expect(customEventRouting({ ...base, activeSceneId, eventName: "chime" })).toEqual({
        error: "unsupported_event",
        ok: false,
        reason: "event_not_declared",
        status: 404,
      });
    }
  });

  it("falls back to any assigned scene when the one showing is not known to the cloud", () => {
    for (const activeSceneId of [undefined, "uploaded/a-preview"]) {
      expect(customEventRouting({ ...base, activeSceneId, eventName: "chime" })).toMatchObject({ ok: true });
      expect(customEventRouting({ ...base, activeSceneId, eventName: "other" })).toMatchObject({
        error: "unsupported_event",
      });
    }
    expect(
      customEventRouting({ ...base, activeSceneId: undefined, eventName: "nextPage", scenes: [] }),
    ).toMatchObject({ error: "unsupported_event" });
  });

  it("names the update when the declaration is there and the firmware is not", () => {
    expect(
      customEventRouting({ ...base, activeSceneId: "pager", eventName: "nextPage", frameosVersion: "2026.9.20" }),
    ).toEqual({ error: "frame_update_required", minFrameosVersion: "2026.9.21", ok: false, status: 409 });
    // Undeclared stays a 404 on old firmware: updating would not help.
    expect(
      customEventRouting({ ...base, activeSceneId: "pager", eventName: "chime", frameosVersion: null }),
    ).toMatchObject({ error: "unsupported_event" });
  });

  it("is not a route for contract events, prototype keys or unusable names", () => {
    const scenes = [
      { customEvents: [{ name: "reboot", origins: ["cloud"] }, { name: "constructor", origins: ["schedule"] }], id: "x" },
    ];
    for (const eventName of ["reboot", "render", "constructor", "__proto__", "", "x".repeat(64)]) {
      expect(
        customEventRouting({ ...base, activeSceneId: "x", eventName, scenes }),
        eventName,
      ).toMatchObject({ error: "unsupported_event" });
    }
  });
});

describe("sceneEventCommand", () => {
  it("builds {name, payload?}", () => {
    expect(sceneEventCommand("nextPage")).toEqual({ ok: true, payload: { name: "nextPage" } });
    expect(sceneEventCommand("nextPage", null)).toEqual({ ok: true, payload: { name: "nextPage" } });
    expect(sceneEventCommand("nextPage", { by: 2 })).toEqual({
      ok: true,
      payload: { name: "nextPage", payload: { by: 2 } },
    });
  });

  it("holds the name to the contract's length, in bytes", () => {
    expect(sceneEventCommand("x".repeat(63)).ok).toBe(true);
    expect(sceneEventCommand("x".repeat(64))).toMatchObject({ error: "invalid_event" });
    // 32 two-byte characters are 64 bytes in the firmware's buffer.
    expect(sceneEventCommand("ä".repeat(32))).toMatchObject({ error: "invalid_event" });
    expect(sceneEventCommand("")).toMatchObject({ error: "invalid_event" });
    expect(sceneEventCommand(7)).toMatchObject({ error: "invalid_event" });
  });

  it("refuses contract events that have a verb of their own", () => {
    for (const name of ["reboot", "restart", "uploadScenes", "metrics", "render", "setCurrentScene", "init"]) {
      expect(sceneEventCommand(name), name).toEqual({ error: "event_not_allowed", ok: false, status: 400 });
    }
  });

  it("takes a small JSON object as the payload and nothing else", () => {
    expect(sceneEventCommand("nextPage", [1])).toMatchObject({ error: "invalid_payload" });
    expect(sceneEventCommand("nextPage", "text")).toMatchObject({ error: "invalid_payload" });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(sceneEventCommand("nextPage", circular)).toMatchObject({ error: "invalid_payload" });
    expect(
      sceneEventCommand("nextPage", { text: "x".repeat(maxSceneEventPayloadBytes) }),
    ).toMatchObject({ error: "payload_too_large" });
  });
});

describe("sceneStateEventCommand", () => {
  it("is setSceneState with the state, asking for the render", () => {
    expect(sceneStateEventCommand({ city: "Tartu" })).toEqual({
      ok: true,
      payload: { name: "setSceneState", payload: { render: true, state: { city: "Tartu" } } },
    });
    expect(sceneStateEventCommand(undefined)).toEqual({ error: "invalid_state", ok: false, status: 400 });
  });
});

describe("buttonEventCommand", () => {
  it("passes the contract's three keys through and drops the rest", () => {
    expect(buttonEventCommand({ label: "A", level: 0, pin: 5, sceneId: "x" })).toEqual({
      ok: true,
      payload: { name: "button", payload: { label: "A", level: 0, pin: 5 } },
    });
    expect(buttonEventCommand({ label: "A" })).toEqual({
      ok: true,
      payload: { name: "button", payload: { label: "A" } },
    });
  });

  it("refuses a press that names no button, or names one badly", () => {
    for (const body of [{}, { level: 1 }, { pin: "5" }, { pin: -1 }, { pin: 1.5 }, { label: "" }, { label: 7 }, { level: "low", pin: 5 }]) {
      expect(buttonEventCommand(body), JSON.stringify(body)).toMatchObject({ error: "invalid_payload" });
    }
  });
});

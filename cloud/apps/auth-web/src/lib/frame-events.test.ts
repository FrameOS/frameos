import { describe, expect, it } from "vitest";
import { reportedActiveSceneId, sceneStateCommand } from "./frame-events";

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

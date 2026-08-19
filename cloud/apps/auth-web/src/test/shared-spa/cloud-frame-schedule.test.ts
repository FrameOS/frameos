import { describe, expect, it } from "vitest";
import {
  allowedFrameCommandTypes,
  maxScheduleEventPayloadBytes,
  maxScheduleEvents,
  scheduleDevicePayload,
  validateFrameSchedule,
} from "../../lib/frames";

// The Schedule panel's cloud write path: POST /api/frames/{id}/schedule
// validates with validateFrameSchedule, persists the full schedule (so the
// panel round-trips disabled events) and enqueues set_schedule carrying
// scheduleDevicePayload — devices fire every event they are given, so the
// disabled flags must be resolved before the wire (the backend's
// embedded_device.py does the same for its settings poll).

function event(overrides: Record<string, unknown> = {}) {
  return {
    event: "setCurrentScene",
    hour: 8,
    id: "11111111-2222-3333-4444-555555555555",
    minute: 30,
    payload: { sceneId: "scene-1", state: {} },
    weekday: 0,
    ...overrides,
  };
}

describe("validateFrameSchedule", () => {
  it("accepts the Schedule panel's shape and materializes defaults", () => {
    const { error, schedule } = validateFrameSchedule({
      events: [event(), event({ id: "b", payload: undefined, weekday: undefined })],
    });
    expect(error).toBeUndefined();
    expect(schedule?.events).toHaveLength(2);
    // Absent weekday/payload come back explicit, so the two device parsers
    // (config.nim loadSchedule, fos_schedule.c) never disagree on defaults.
    expect(schedule?.events[1]).toEqual({
      event: "setCurrentScene",
      hour: 8,
      id: "b",
      minute: 30,
      payload: {},
      weekday: 0,
    });
  });

  it("keeps disabled flags — they are provider-side state", () => {
    const { schedule } = validateFrameSchedule({
      disabled: true,
      events: [event({ disabled: true })],
    });
    expect(schedule?.disabled).toBe(true);
    expect(schedule?.events[0]?.disabled).toBe(true);
  });

  it("accepts the panel's maintenance entries — restart and reboot with an empty payload", () => {
    // The SPA's scheduled "Restart FrameOS" / "Reboot device" entries
    // (frontend/src/utils/scheduleEvents.ts). The device runs them itself
    // (runner.nim `restart`/`reboot`, fos_schedule.c) — there is no scene
    // to name, so the payload is {} and must survive as such.
    const { error, schedule } = validateFrameSchedule({
      events: [
        event({ event: "restart", payload: {} }),
        event({ event: "reboot", hour: 4, id: "reboot-1", minute: 0 }),
      ],
    });
    expect(error).toBeUndefined();
    expect(
      schedule?.events.map((entry) => [entry.event, entry.payload]),
    ).toEqual([
      ["restart", {}],
      ["reboot", { sceneId: "scene-1", state: {} }],
    ]);
    const { schedule: cleared } = validateFrameSchedule({
      events: [event({ event: "reboot", payload: undefined })],
    });
    expect(cleared?.events[0]).toMatchObject({ event: "reboot", payload: {} });
  });

  it("accepts an empty events list (a cleared schedule)", () => {
    expect(validateFrameSchedule({ events: [] })).toEqual({
      schedule: { events: [] },
    });
  });

  it("refuses the whole schedule on one invalid event, never drops it", () => {
    for (const bad of [
      event({ minute: 60 }),
      event({ minute: 1.5 }),
      event({ hour: 24 }),
      event({ hour: -1 }),
      event({ weekday: 10 }),
      event({ weekday: "1" }),
      event({ id: "" }),
      event({ id: 7 }),
      event({ event: "" }),
      event({ event: "x".repeat(64) }),
      event({ payload: [] }),
      event({ payload: "boom" }),
      event({ disabled: "yes" }),
      "not-an-object",
    ]) {
      expect(
        validateFrameSchedule({ events: [event(), bad] }).error,
        JSON.stringify(bad),
      ).toBe("invalid_schedule");
    }
  });

  it("refuses non-schedule shapes", () => {
    for (const bad of [undefined, null, [], "x", 5, {}, { events: {} }]) {
      expect(validateFrameSchedule(bad).error).toBe("invalid_schedule");
    }
  });

  it("enforces the ESP32-sized caps", () => {
    expect(
      validateFrameSchedule({
        events: Array.from({ length: maxScheduleEvents + 1 }, (_, i) =>
          event({ id: `id-${i}` }),
        ),
      }).error,
    ).toBe("schedule_too_large");
    expect(
      validateFrameSchedule({
        events: [
          event({
            payload: { blob: "x".repeat(maxScheduleEventPayloadBytes) },
          }),
        ],
      }).error,
    ).toBe("schedule_too_large");
  });

  it("sanitizes by reconstruction: unknown keys never reach the jsonb", () => {
    const { schedule } = validateFrameSchedule({
      events: [event({ shell: "rm -rf /" })],
      extra: true,
    });
    expect(schedule).toEqual({ events: [event()] });
  });
});

describe("scheduleDevicePayload", () => {
  it("strips disabled events and the disabled flags from the push", () => {
    const { schedule } = validateFrameSchedule({
      events: [event(), event({ disabled: true, id: "off" })],
    });
    expect(scheduleDevicePayload(schedule!)).toEqual({ events: [event()] });
  });

  it("ships a disabled schedule as zero events, not null — the Pi handler refuses a non-object schedule", () => {
    const { schedule } = validateFrameSchedule({
      disabled: true,
      events: [event()],
    });
    expect(scheduleDevicePayload(schedule!)).toEqual({ events: [] });
  });
});

describe("set_schedule as a command verb", () => {
  it("is enqueueable — the hub delivers whatever the durable queue holds", () => {
    expect(allowedFrameCommandTypes.has("set_schedule")).toBe(true);
  });
});

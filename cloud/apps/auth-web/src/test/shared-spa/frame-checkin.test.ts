// "Last seen just now" for a battery frame that deep-sleeps between renders
// says nothing about when a queued deploy lands. frameCheckin turns the
// device's own sleep forecast (next_wake_at / next_render_at from its `sleep`
// message) — or, on older firmware, the power settings the cloud pushed —
// into "asleep · wakes in 5 min" and "overdue". Pure functions, tested from
// auth-web like the other shared-SPA logic (frontend/ has no test runner).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatFrameDuration,
  frameActivityDescription,
  frameCheckin,
  frameIsStale,
  frameStatusDescription,
} from "../../../../../../frontend/src/decorators/frame";
import { groupFramesByStatus } from "../../../../../../frontend/src/scenes/workspace/frameStatusGroups";
import type { FrameType } from "../../../../../../frontend/src/types";

const now = Date.parse("2026-08-27T12:00:00Z");
const at = (offsetSeconds: number) =>
  new Date(now + offsetSeconds * 1000).toISOString();

function cloudFrame(fields: Partial<FrameType>): FrameType {
  return {
    id: "frame-1",
    name: "Frame",
    managed_by: "cloud",
    status: "active",
    connected: false,
    scenes_checksum: "sum",
    ...fields,
  } as FrameType;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a frame that announced its sleep", () => {
  it("is asleep until the announced wake, and says when it is back", () => {
    const frame = cloudFrame({
      last_seen_at: at(-30),
      next_wake_at: at(5 * 60),
      sleep_reason: "battery",
    });
    expect(frameCheckin(frame, now)).toMatchObject({
      announced: true,
      kind: "sleeping",
      reason: "battery",
      renderAt: null,
    });
    expect(frameActivityDescription(frame)).toBe("asleep · wakes in 5 min");
    expect(frameStatusDescription(frame)).toBe("asleep · wakes in 5 min");
  });

  it("names the later panel refresh when the wake is only a check-in", () => {
    const frame = cloudFrame({
      last_seen_at: at(-30),
      next_wake_at: at(15 * 60),
      next_render_at: at(2 * 3600 + 10 * 60),
    });
    expect(frameActivityDescription(frame)).toBe(
      "asleep · wakes in 15 min · renders in 2 h 10 min",
    );
  });

  it("folds a render due within a minute of the wake into the wake", () => {
    const frame = cloudFrame({
      next_wake_at: at(600),
      next_render_at: at(630),
    });
    expect(frameCheckin(frame, now)?.renderAt).toBeNull();
  });

  it("is not stale while asleep on schedule, however long ago it was seen", () => {
    const frame = cloudFrame({
      last_seen_at: at(-11 * 3600),
      next_wake_at: at(3600),
    });
    expect(frameIsStale(frame)).toBe(false);
    expect(groupFramesByStatus([frame])[0]?.key).toBe("active");
  });

  it("stays 'asleep' through the boot-and-dial grace after the wake", () => {
    expect(
      frameCheckin(cloudFrame({ next_wake_at: at(-60) }), now)?.kind,
    ).toBe("sleeping");
    expect(frameActivityDescription(cloudFrame({ next_wake_at: at(-60) }))).toBe(
      "asleep · wakes any moment now",
    );
  });

  it("is overdue once the wake plus grace has passed", () => {
    const frame = cloudFrame({
      last_seen_at: at(-20 * 60),
      next_wake_at: at(-10 * 60),
    });
    expect(frameCheckin(frame, now)?.kind).toBe("overdue");
    expect(frameActivityDescription(frame)).toBe(
      "overdue · expected 10 minutes ago · last seen 20 minutes ago",
    );
  });

  it("is a plain online frame once it has reconnected", () => {
    const frame = cloudFrame({
      connected: true,
      last_seen_at: at(-5),
      // The hub clears this on connect; even a stale copy must not win.
      next_wake_at: at(600),
    });
    expect(frameCheckin(frame, now)).toBeNull();
    expect(frameStatusDescription(frame)).toBe("online - last seen just now");
  });

  it("reads a disconnected cloud frame without a forecast as offline", () => {
    const frame = cloudFrame({ last_seen_at: at(-5 * 60) });
    expect(frameCheckin(frame, now)).toBeNull();
    expect(frameStatusDescription(frame)).toBe("offline - last seen 5 minutes ago");
  });
});

describe("estimating the wake from the power settings (older firmware)", () => {
  it("uses the wake check period when it is shorter than the render interval", () => {
    const frame = cloudFrame({
      deep_sleep: true,
      interval: 3600,
      last_seen_at: at(-5 * 60),
      wake_check_seconds: 900,
    });
    expect(frameCheckin(frame, now)).toMatchObject({
      announced: false,
      kind: "sleeping",
      wakeAt: now + 10 * 60 * 1000,
    });
    expect(frameActivityDescription(frame)).toBe("asleep · wakes in ~10 min");
  });

  it("uses the render interval when the wake check is longer or off", () => {
    expect(
      frameCheckin(
        cloudFrame({ deep_sleep: true, interval: 300, last_seen_at: at(-60), wake_check_seconds: 3600 }),
        now,
      )?.wakeAt,
    ).toBe(now + 4 * 60 * 1000);
    expect(
      frameCheckin(
        cloudFrame({ deep_sleep: true, interval: 300, last_seen_at: at(-60), wake_check_seconds: 0 }),
        now,
      )?.wakeAt,
    ).toBe(now + 4 * 60 * 1000);
  });

  it("only counts deep_sleep_on_battery when the device reports a cell", () => {
    const base = {
      deep_sleep_on_battery: true,
      interval: 600,
      last_seen_at: at(-60),
    };
    expect(frameCheckin(cloudFrame(base), now)).toBeNull();
    expect(
      frameCheckin(cloudFrame({ ...base, last_metrics: { onBattery: false, batteryPercent: 90 } }), now),
    ).toBeNull();
    expect(
      frameCheckin(cloudFrame({ ...base, last_metrics: { onBattery: true, batteryPercent: 90 } }), now)?.kind,
    ).toBe("sleeping");
    // Firmware before onBattery: the millivolt reading against the
    // firmware's own "cell present" threshold.
    expect(
      frameCheckin(cloudFrame({ ...base, last_metrics: { batteryMillivolts: 3900 } }), now)?.kind,
    ).toBe("sleeping");
    expect(
      frameCheckin(cloudFrame({ ...base, last_metrics: { batteryMillivolts: 100 } }), now),
    ).toBeNull();
  });

  it("gives an estimate half a cycle of slack before calling it overdue", () => {
    const frame = cloudFrame({ deep_sleep: true, interval: 600, wake_check_seconds: 0 });
    expect(frameCheckin({ ...frame, last_seen_at: at(-15 * 60) }, now)?.kind).toBe("sleeping");
    expect(frameCheckin({ ...frame, last_seen_at: at(-20 * 60) }, now)).toMatchObject({
      announced: false,
      kind: "overdue",
    });
    expect(frameActivityDescription({ ...frame, last_seen_at: at(-20 * 60) })).toBe(
      "overdue · expected ~10 minutes ago · last seen 20 minutes ago",
    );
  });

  it("reads a backend-managed embedded frame's device_config too", () => {
    const frame = {
      id: 1,
      name: "Pico",
      status: "ready",
      mode: "embedded",
      interval: 900,
      last_log_at: at(-2 * 60),
      device_config: { deepSleep: true, wakeCheckSeconds: 300 },
    } as unknown as FrameType;
    expect(frameActivityDescription(frame)).toBe("asleep · wakes in ~3 min");
  });

  it("leaves frames that never sleep alone", () => {
    expect(frameCheckin(cloudFrame({ last_seen_at: at(-60), interval: 60 }), now)).toBeNull();
    expect(
      frameCheckin(cloudFrame({ deep_sleep: false, deep_sleep_on_battery: false, last_seen_at: at(-60) }), now),
    ).toBeNull();
  });
});

describe("formatFrameDuration", () => {
  it("picks the resolution a waiting person wants", () => {
    expect(formatFrameDuration(20_000)).toBe("under a minute");
    expect(formatFrameDuration(5 * 60_000)).toBe("5 min");
    expect(formatFrameDuration(60 * 60_000)).toBe("1 h");
    expect(formatFrameDuration(130 * 60_000)).toBe("2 h 10 min");
    expect(formatFrameDuration(24 * 3_600_000)).toBe("1 day");
    expect(formatFrameDuration(50 * 3_600_000)).toBe("2 d 2 h");
  });
});

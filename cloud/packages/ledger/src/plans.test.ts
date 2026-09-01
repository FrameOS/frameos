import { describe, expect, it } from "vitest";
import { fallbackPaygPlan } from "./plans";
import { addMonth } from "./subscriptions";
import { utcDayWindow, utcMonthWindow } from "./account-usage";

describe("the free plan fallback", () => {
  // The numbers a deployment falls back to when nobody has seeded plans must
  // be the numbers it already enforced, or migration 0045 would quietly take
  // storage away from every existing account.
  it("matches the historical free tier", () => {
    expect(fallbackPaygPlan.entitlements).toEqual({
      backupBytes: 100 * 1024 * 1024,
      cloudRenderedFrames: 0,
      frameLogBytes: 100 * 1024 * 1024,
      frames: 50,
      privateSceneBytes: 100 * 1024 * 1024,
    });
    expect(fallbackPaygPlan.priceMicros).toBe(0n);
  });
});

describe("addMonth", () => {
  it("moves to the same day of the next month", () => {
    expect(addMonth(new Date("2026-01-15T10:30:00Z")).toISOString()).toBe(
      "2026-02-15T10:30:00.000Z",
    );
  });

  // A subscription started on the 31st must renew on the 28th rather than
  // skipping February entirely, which is what naive month arithmetic does.
  it("clamps into a short month instead of overflowing past it", () => {
    expect(addMonth(new Date("2026-01-31T00:00:00Z")).toISOString()).toBe(
      "2026-02-28T00:00:00.000Z",
    );
    expect(addMonth(new Date("2028-01-31T00:00:00Z")).toISOString()).toBe(
      "2028-02-29T00:00:00.000Z",
    );
    expect(addMonth(new Date("2026-03-31T00:00:00Z")).toISOString()).toBe(
      "2026-04-30T00:00:00.000Z",
    );
  });

  it("rolls the year over", () => {
    expect(addMonth(new Date("2026-12-05T00:00:00Z")).toISOString()).toBe(
      "2027-01-05T00:00:00.000Z",
    );
  });
});

describe("usage windows", () => {
  it("cuts the day at UTC midnight, half-open", () => {
    const window = utcDayWindow(new Date("2026-09-01T23:59:59.999Z"));
    expect(window.since.toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(window.until.toISOString()).toBe("2026-09-02T00:00:00.000Z");
  });

  it("cuts the month at the first, and counts offsets backwards", () => {
    const at = new Date("2026-09-17T12:00:00Z");
    expect(utcMonthWindow(at).since.toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(utcMonthWindow(at).until.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(utcMonthWindow(at, -1).since.toISOString()).toBe(
      "2026-08-01T00:00:00.000Z",
    );
    expect(utcMonthWindow(at, -1).until.toISOString()).toBe(
      "2026-09-01T00:00:00.000Z",
    );
  });

  it("crosses the year boundary going backwards", () => {
    const window = utcMonthWindow(new Date("2026-01-10T00:00:00Z"), -1);
    expect(window.since.toISOString()).toBe("2025-12-01T00:00:00.000Z");
    expect(window.until.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });
});

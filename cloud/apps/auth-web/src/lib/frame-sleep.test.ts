import { describe, expect, it } from "vitest";
import {
  commandTtlForFrame,
  frameIsAsleep,
  maxSleepWaitMs,
  previewWatchGraceMs,
} from "./frame-sleep";

const now = Date.parse("2026-08-28T13:00:00Z");
const twoMinutes = 2 * 60 * 1000;

describe("commandTtlForFrame", () => {
  it("is the base TTL for an awake frame", () => {
    expect(commandTtlForFrame({ nextWakeAt: null }, twoMinutes, now)).toBe(twoMinutes);
  });

  it("is the base TTL when the forecast is already past", () => {
    const frame = { nextWakeAt: new Date(now - 1000) };
    expect(commandTtlForFrame(frame, twoMinutes, now)).toBe(twoMinutes);
  });

  it("reaches past the announced wake by the base TTL", () => {
    // A 15-minute weather frame: the command must survive the whole sleep.
    const frame = { nextWakeAt: new Date(now + 14 * 60 * 1000) };
    expect(commandTtlForFrame(frame, twoMinutes, now)).toBe(14 * 60 * 1000 + twoMinutes);
  });

  it("caps a broken forecast at the firmware's longest sleep", () => {
    const frame = { nextWakeAt: new Date(now + 365 * 86_400 * 1000) };
    expect(commandTtlForFrame(frame, twoMinutes, now)).toBe(maxSleepWaitMs + twoMinutes);
  });
});

describe("frameIsAsleep", () => {
  it("reads the forecast", () => {
    expect(frameIsAsleep({ nextWakeAt: null }, now)).toBe(false);
    expect(frameIsAsleep({ nextWakeAt: new Date(now - 1) }, now)).toBe(false);
    expect(frameIsAsleep({ nextWakeAt: new Date(now + 1) }, now)).toBe(true);
  });
});

describe("previewWatchGraceMs", () => {
  it("is zero without an announced sleep", () => {
    expect(previewWatchGraceMs(undefined)).toBe(0);
    expect(previewWatchGraceMs(0)).toBe(0);
    expect(previewWatchGraceMs(Number.NaN)).toBe(0);
  });

  it("stretches the watch window by one sleep", () => {
    expect(previewWatchGraceMs(838)).toBe(838_000);
    expect(previewWatchGraceMs(838.4)).toBe(838_000);
  });

  it("is bounded", () => {
    expect(previewWatchGraceMs(10 ** 9)).toBe(maxSleepWaitMs);
  });
});

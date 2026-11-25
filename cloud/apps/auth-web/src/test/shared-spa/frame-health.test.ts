// Every render moves a backend frame's status to "rendering" and back to
// "ready" (backend/app/models/log.py), and a deploy moves it through
// "deploying" and "starting". The frame's green dot (frameIsHealthy) and the
// deploy drawer's "is it online" (frameIsActive: the over-the-air card above
// the USB one) must not follow those words: on a reTerminal Sticky showing a
// scene that renders every second, both flipped twice a second (2026-11-24).
// Pure functions, tested from auth-web like the other shared-SPA logic.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  frameIsActive,
  frameIsHealthy,
} from "../../../../../../frontend/src/decorators/frame";
import type { FrameType } from "../../../../../../frontend/src/types";

const now = Date.parse("2026-11-24T22:40:00Z");
const ago = (seconds: number) => new Date(now - seconds * 1000).toISOString();

function esp32Frame(fields: Partial<FrameType>): FrameType {
  return {
    id: 75,
    name: "Stick",
    mode: "embedded",
    status: "ready",
    last_log_at: ago(1),
    ...fields,
  } as FrameType;
}

function neverHeardFrom(status: string): FrameType {
  const { last_log_at: _heard, ...frame } = esp32Frame({ status });
  return frame as FrameType;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a frame's health through its renders and deploys", () => {
  const busy = ["ready", "preparing", "rendering", "deploying", "starting", "restarting"];

  it("stays healthy and online whatever its render or deploy says", () => {
    for (const status of busy) {
      const frame = esp32Frame({ status });
      expect(frameIsHealthy(frame), status).toBe(true);
      expect(frameIsActive(frame), status).toBe(true);
    }
  });

  it("is not healthy when a deploy failed", () => {
    expect(frameIsHealthy(esp32Frame({ status: "uninitialized" }))).toBe(false);
  });

  it("is not healthy busy before it was ever heard from", () => {
    // A first deploy of a frame that never logged: nothing says it is up.
    expect(frameIsHealthy(neverHeardFrom("deploying"))).toBe(false);
    expect(frameIsHealthy(neverHeardFrom("ready"))).toBe(true);
  });

  it("is neither healthy nor online when it went quiet over an hour ago", () => {
    for (const status of busy) {
      const frame = esp32Frame({ status, last_log_at: ago(2 * 60 * 60) });
      expect(frameIsHealthy(frame), status).toBe(false);
      expect(frameIsActive(frame), status).toBe(false);
    }
  });
});

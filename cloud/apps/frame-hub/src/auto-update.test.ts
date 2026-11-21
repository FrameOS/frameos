import { describe, expect, it } from "vitest";
import {
  autoUpdateNudgeEveryMs,
  autoUpdateTarget,
  autoUpdateVerdict,
  localHour,
  type AutoUpdateCandidate,
} from "./auto-update";

// The sweep's choice per frame (docs/auto-updates.md "When"); the rule itself
// is pinned by auth-web's update-decision.test.ts.

const full = [{ afterHours: 0, percent: 100 }];
const manifest = {
  defaultRollout: full,
  releases: [
    { version: "2026.11.13", at: "2026-11-20T00:00:00Z" },
    { version: "2026.11.14", at: "2026-11-21T00:00:00Z", steppingStone: true },
    { version: "2026.11.15", at: "2026-11-22T00:00:00Z" },
  ],
};
// 03:00 UTC: inside the window for a frame without a time zone.
const night = new Date("2026-11-25T03:00:00Z");

function frame(overrides: Partial<AutoUpdateCandidate> = {}): AutoUpdateCandidate {
  return {
    accountId: "acct",
    deployProgress: null,
    frameosVersion: "2026.11.14",
    hardware: { platform: "rpios" },
    id: "11111111-2222-3333-4444-555555555555",
    lastNudgeAt: null,
    nextWakeAt: null,
    settings: null,
    status: "active",
    virtual: false,
    ...overrides,
  };
}

describe("autoUpdateVerdict", () => {
  it("nudges a frame behind the latest, in its window", () => {
    expect(autoUpdateVerdict(frame(), manifest, night)).toMatchObject({ nudge: true, version: "2026.11.15" });
  });

  it("an esp32 is asked about its chip's image", () => {
    expect(
      autoUpdateVerdict(frame({ hardware: { platform: "esp32-s3" }, frameosVersion: "2026.11.14" }), manifest, night),
    ).toMatchObject({ nudge: true, version: "2026.11.15" });
  });

  it("skips what the owner turned off, a virtual frame, one a backend manages, a dev build, one not confirmed", () => {
    expect(autoUpdateVerdict(frame({ settings: { auto_update: false } }), manifest, night)).toEqual({
      nudge: false,
      skip: "disabled",
    });
    expect(autoUpdateVerdict(frame({ virtual: true }), manifest, night)).toMatchObject({ skip: "virtual" });
    expect(
      autoUpdateVerdict(frame({ hardware: { platform: "esp32-s3", backend: "http://10.0.0.2:8989" } }), manifest, night),
    ).toMatchObject({ skip: "backend_managed" });
    expect(autoUpdateVerdict(frame({ frameosVersion: "dev" }), manifest, night)).toMatchObject({
      skip: "unknown_version",
    });
    expect(autoUpdateVerdict(frame({ status: "pending" }), manifest, night)).toMatchObject({ skip: "not_active" });
  });

  it("only in the frame's own night", () => {
    expect(autoUpdateVerdict(frame(), manifest, new Date("2026-11-25T12:00:00Z"))).toMatchObject({
      skip: "outside_window",
    });
    // 03:00 UTC is 22:00 in New York the evening before.
    expect(
      autoUpdateVerdict(frame({ settings: { timezone: "America/New_York" } }), manifest, night),
    ).toMatchObject({ skip: "outside_window" });
    // 08:00 UTC is 03:00 in New York.
    expect(
      autoUpdateVerdict(frame({ settings: { timezone: "America/New_York" } }), manifest, new Date("2026-11-25T08:00:00Z")),
    ).toMatchObject({ nudge: true });
  });

  it("not twice in 20 hours, and not while something is in flight", () => {
    expect(
      autoUpdateVerdict(frame({ lastNudgeAt: new Date(night.getTime() - autoUpdateNudgeEveryMs + 1000) }), manifest, night),
    ).toMatchObject({ skip: "recently_nudged" });
    expect(
      autoUpdateVerdict(frame({ lastNudgeAt: new Date(night.getTime() - autoUpdateNudgeEveryMs - 1000) }), manifest, night),
    ).toMatchObject({ nudge: true });
    const running = {
      at: new Date(night.getTime() - 30_000).toISOString(),
      id: "cmd",
      kind: "upgrade",
      stage: "queued",
      status: "running",
      startedAt: new Date(night.getTime() - 30_000).toISOString(),
    };
    expect(autoUpdateVerdict(frame({ deployProgress: running }), manifest, night)).toMatchObject({
      skip: "in_flight",
    });
    // A record long past its stage's staleness no longer holds the frame.
    const stale = { ...running, at: "2026-11-01T00:00:00Z", startedAt: "2026-11-01T00:00:00Z" };
    expect(autoUpdateVerdict(frame({ deployProgress: stale }), manifest, night)).toMatchObject({ nudge: true });
  });

  it("an older Linux runtime is nudged only to the latest: it ignores the version and takes GitHub's", () => {
    // 2026.11.13 needs the stone 2026.11.14 first, which such a runtime would skip.
    expect(autoUpdateVerdict(frame({ frameosVersion: "2026.11.13" }), manifest, night)).toMatchObject({
      nudge: false,
      skip: "runtime_installs_latest_only",
    });
    // An ESP32 asks its manifest route, which runs the rule: the stone it is.
    expect(
      autoUpdateVerdict(frame({ frameosVersion: "2026.11.13", hardware: { platform: "esp32-c3" } }), manifest, night),
    ).toMatchObject({ nudge: true, version: "2026.11.14" });
  });

  it("nothing when the rule holds it or it is up to date", () => {
    expect(autoUpdateVerdict(frame({ frameosVersion: "2026.11.15" }), manifest, night)).toMatchObject({
      nudge: false,
      skip: "up_to_date",
    });
  });
});

describe("autoUpdateTarget / localHour", () => {
  it("reads what the hello reports", () => {
    expect(autoUpdateTarget({ platform: "esp32-c3" })).toEqual({ platform: "esp32", target: "esp32-c3-generic" });
    expect(autoUpdateTarget({ platform: "esp32-s3", otaPlatform: "esp32-s3-16mb" })).toEqual({
      platform: "esp32",
      target: "esp32-s3-16mb",
    });
    expect(autoUpdateTarget({ platform: "rpios", upgradeTarget: "debian-bookworm-arm64" })).toEqual({
      platform: "linux",
      target: "debian-bookworm-arm64",
    });
    expect(autoUpdateTarget({ platform: "buildroot" })).toEqual({ platform: "linux", target: "" });
  });

  it("falls back to UTC for a zone it does not know", () => {
    expect(localHour("Not/AZone", night)).toBe(3);
    expect(localHour(undefined, night)).toBe(3);
    expect(localHour("Europe/Brussels", night)).toBe(4);
  });
});

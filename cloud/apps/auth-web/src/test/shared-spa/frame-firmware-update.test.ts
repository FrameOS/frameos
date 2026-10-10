// The hub folds the device's `ota:<plane>` log lines into the frame row
// (firmware_update); frameFirmwareUpdateProgress turns that into the frames
// list's status word, so a frame half-way through a download says
// "updating firmware 42%" instead of "waiting to sync". Pure function,
// tested from auth-web like the other shared-SPA logic.
import { describe, expect, it } from "vitest";
import { frameFirmwareUpdateProgress } from "../../../../../../frontend/src/decorators/frame";
import type { FrameType } from "../../../../../../frontend/src/types";

const now = Date.parse("2026-10-10T16:40:00Z");
const frame = (firmware_update: FrameType["firmware_update"]): FrameType =>
  ({ id: "f1", firmware_update }) as unknown as FrameType;
const at = (secondsAgo: number) => new Date(now - secondsAgo * 1000).toISOString();

describe("frameFirmwareUpdateProgress", () => {
  it("reads a download's progress line as a percentage", () => {
    const progress = frameFirmwareUpdateProgress(
      frame({ status: "progress", detail: "524288/3224928", version: "2026.10.3", at: at(10) }),
      now,
    );
    expect(progress).toMatchObject({ kind: "running", label: "updating firmware 16%", percent: 16 });
    expect(progress?.title).toContain("2026.10.3");
  });

  it("says it is downloading before the first progress line, and rebooting after verification", () => {
    expect(
      frameFirmwareUpdateProgress(frame({ status: "downloading", detail: "2026.10.3", version: "2026.10.3", at: at(1) }), now),
    ).toMatchObject({ label: "updating firmware", percent: null });
    expect(
      frameFirmwareUpdateProgress(frame({ status: "verified", detail: "rebooting", version: "2026.10.3", at: at(1) }), now),
    ).toMatchObject({ kind: "running", label: "rebooting into 2026.10.3", percent: 100 });
  });

  it("forgets a download that stopped reporting, but keeps a failure for a while", () => {
    expect(
      frameFirmwareUpdateProgress(frame({ status: "progress", detail: "1/2", at: at(20 * 60) }), now),
    ).toBeNull();
    expect(
      frameFirmwareUpdateProgress(frame({ status: "error", detail: "signature-rejected", at: at(60 * 60) }), now),
    ).toMatchObject({ kind: "failed", label: "update failed" });
    expect(
      frameFirmwareUpdateProgress(frame({ status: "error", detail: "signature-rejected", at: at(7 * 60 * 60) }), now),
    ).toBeNull();
  });

  it("says nothing when the device was already up to date, or there is no line", () => {
    expect(frameFirmwareUpdateProgress(frame({ status: "up-to-date", detail: "2026.10.3", at: at(1) }), now)).toBeNull();
    expect(frameFirmwareUpdateProgress(frame(null), now)).toBeNull();
    expect(frameFirmwareUpdateProgress(frame(undefined), now)).toBeNull();
  });
});

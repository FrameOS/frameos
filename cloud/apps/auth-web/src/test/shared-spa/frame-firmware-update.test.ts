// The hub folds the device's `ota:<plane>` log lines into the frame row
// (firmware_update); frameFirmwareUpdateProgress turns that into the frames
// list's status word, so a frame half-way through a download says
// "updating firmware 42%" instead of "waiting to sync". Pure function,
// tested from auth-web like the other shared-SPA logic.
import { describe, expect, it } from "vitest";
import {
  frameFirmwareUpdateIsRunning,
  frameFirmwareUpdateOutcome,
  frameFirmwareUpdateProgress,
} from "../../../../../../frontend/src/decorators/frame";
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
    // The ESP32 waits out a render pass that was already under way before
    // it downloads (`ota:cloud waiting render`): still the update, running.
    const waiting = frameFirmwareUpdateProgress(
      frame({ status: "waiting", detail: "render", version: "2026.10.3", at: at(1) }),
      now,
    );
    expect(waiting).toMatchObject({ kind: "running", label: "updating firmware", percent: null });
    expect(waiting?.title).toBe("Waiting for the frame's render to finish before downloading FrameOS 2026.10.3");
    expect(
      frameFirmwareUpdateProgress(frame({ status: "verified", detail: "rebooting", version: "2026.10.3", at: at(1) }), now),
    ).toMatchObject({ kind: "running", label: "rebooting into 2026.10.3", percent: 100 });
  });

  it("stops saying rebooting once the frame reports the verified version", () => {
    // The Pi's watcher forwards its success line from the NEW runtime,
    // after the hello that already carried 2026.10.6; the row folded it
    // into a fresh "verified" that nothing cleared until the next reconnect.
    const back = {
      id: "f1",
      frameos_version: "2026.10.6",
      firmware_update: { status: "verified", detail: "Restarting services.", version: "2026.10.6", at: at(60) },
    } as unknown as FrameType;
    expect(frameFirmwareUpdateProgress(back, now)).toBeNull();
    const notYet = { ...back, frameos_version: "2026.10.5" } as FrameType;
    expect(frameFirmwareUpdateProgress(notYet, now)).toMatchObject({ label: "rebooting into 2026.10.6" });
  });

  it("calls a download that stopped reporting stalled, and keeps a failure for a while", () => {
    // E1004, 2026-10-12: the download died in a socket gap, its error line
    // never arrived, and the row went from "updating firmware 32%" straight
    // back to "upgrade" as if nothing had been asked.
    const stalled = frameFirmwareUpdateProgress(
      frame({ status: "progress", detail: "1048576/3233648", version: "2026.10.8", at: at(20 * 60) }),
      now,
    );
    expect(stalled).toMatchObject({ kind: "failed", label: "update stalled", percent: 32, version: "2026.10.8" });
    expect(stalled?.title).toBe(
      "The firmware update 2026.10.8 stopped reporting at 32%; the frame may have lost its connection or restarted. See the ota or cloud:upgrade lines in Logs.",
    );
    expect(
      frameFirmwareUpdateProgress(frame({ status: "progress", detail: "1/2", at: at(7 * 60 * 60) }), now),
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

describe("frameFirmwareUpdateProgress (Pi lines, folded by the hub into the same vocabulary)", () => {
  it("believes a download without byte counts for as long as the device's own stall watchdog", () => {
    // frameos/upgrade.nim reports phases, not bytes: "running" lands as
    // `downloading` with the device's sentence as detail, and a 40 MB archive
    // over slow Wi-Fi takes a while.
    const progress = frameFirmwareUpdateProgress(
      frame({ status: "downloading", detail: "FrameOS upgrade is running.", version: "2026.10.5", at: at(30 * 60) }),
      now,
    );
    expect(progress).toMatchObject({ kind: "running", label: "updating firmware", percent: null, version: "2026.10.5" });
    expect(progress?.title).toBe("Downloading FrameOS 2026.10.5: FrameOS upgrade is running.");
    expect(
      frameFirmwareUpdateProgress(frame({ status: "downloading", detail: "x", at: at(50 * 60) }), now),
    ).toMatchObject({ kind: "failed", label: "update stalled", percent: null });
    // Byte counts come every few seconds, so their silence is believed sooner.
    expect(
      frameFirmwareUpdateProgress(frame({ status: "progress", detail: "1/2", at: at(20 * 60) }), now),
    ).toMatchObject({ kind: "failed", label: "update stalled" });
  });

  it("does not repeat the version as the detail, and names the release it restarts into", () => {
    expect(
      frameFirmwareUpdateProgress(frame({ status: "downloading", detail: "2026.10.5", version: "2026.10.5", at: at(1) }), now)
        ?.title,
    ).toBe("Downloading FrameOS 2026.10.5");
    expect(
      frameFirmwareUpdateProgress(
        frame({ status: "verified", detail: "FrameOS upgraded to 2026.10.5. Rebooting to finish.", version: "2026.10.5", at: at(1) }),
        now,
      ),
    ).toMatchObject({ kind: "running", label: "rebooting into 2026.10.5", percent: 100 });
  });

  it("exposes a running flag for the surfaces that only need yes or no", () => {
    expect(frameFirmwareUpdateIsRunning(frame({ status: "progress", detail: "1/2", at: at(1) }), now)).toBe(true);
    expect(frameFirmwareUpdateIsRunning(frame({ status: "error", detail: "x", at: at(1) }), now)).toBe(false);
    // A stalled download is not running either: "Update all" and the
    // drawer's button may ask again.
    expect(frameFirmwareUpdateIsRunning(frame({ status: "progress", detail: "1/2", at: at(20 * 60) }), now)).toBe(false);
    expect(frameFirmwareUpdateIsRunning(frame(null), now)).toBe(false);
  });
});

describe("frameFirmwareUpdateOutcome", () => {
  it("reads the done row the boot after an update leaves, for a day, and keeps it out of the progress word", () => {
    const done = frame({ status: "done", detail: "", version: "2026.10.8", plane: "cloud", at: at(3 * 60) });
    expect(frameFirmwareUpdateOutcome(done, now)).toEqual({ kind: "done", version: "2026.10.8", when: "3 minutes ago", detail: "" });
    // A check that found nothing to install is an outcome for an hour: the
    // ESP32 answers `up-to-date` with the version as its detail.
    expect(
      frameFirmwareUpdateOutcome(frame({ status: "up-to-date", detail: "2026.10.8", version: null, at: at(2 * 60) }), now),
    ).toEqual({ kind: "up-to-date", version: "2026.10.8", when: "2 minutes ago", detail: "" });
    expect(frameFirmwareUpdateOutcome(frame({ status: "up-to-date", detail: "2026.10.8", at: at(2 * 60 * 60) }), now)).toBeNull();
    expect(frameFirmwareUpdateProgress(done, now)).toBeNull();
    expect(frameFirmwareUpdateIsRunning(done, now)).toBe(false);
    // The Pi's success line lands after its hello: the done row carries its sentence.
    expect(
      frameFirmwareUpdateOutcome(
        frame({ status: "done", detail: "FrameOS upgraded to 2026.10.8. Restarting services.", version: "2026.10.8", at: at(60) }),
        now,
      )?.detail,
    ).toBe("FrameOS upgraded to 2026.10.8. Restarting services.");
    expect(frameFirmwareUpdateOutcome(frame({ status: "done", detail: "", version: "2026.10.8", at: at(25 * 60 * 60) }), now)).toBeNull();
    expect(frameFirmwareUpdateOutcome(frame({ status: "progress", detail: "1/2", at: at(1) }), now)).toBeNull();
    expect(frameFirmwareUpdateOutcome(frame(null), now)).toBeNull();
  });
});

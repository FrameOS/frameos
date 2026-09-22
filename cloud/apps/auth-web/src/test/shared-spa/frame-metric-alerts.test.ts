import { describe, expect, it } from "vitest";
import { getFrameMetricAlerts } from "../../../../../../frontend/src/utils/frameMetricAlerts";
import type { FrameType, MetricsType } from "../../../../../../frontend/src/types";

// The frame's disk and upgrade health, as the alert badge on both control
// planes reads it (frameos/metrics.nim). Cloud-W stopped upgrading for a week
// with its disk "10% full": the headline summed a 60 GB assets partition,
// the 90% per-filesystem line sat just above its 89%, and the refused
// upgrades were log lines nobody read.

const MB = 1024 * 1024;
const frame = { id: 1, interval: 300, metrics_interval: 60 } as unknown as FrameType;

function sample(timestamp: string, metrics: Record<string, unknown>): MetricsType {
  return { id: timestamp, timestamp, frame_id: 1, metrics } as unknown as MetricsType;
}

function labels(metrics: MetricsType[]): string[] {
  return getFrameMetricAlerts(frame, metrics).map((alert) => alert.label);
}

describe("upgrade health alerts", () => {
  it("warns when the FrameOS partition cannot fit the next upgrade", () => {
    const diskUsage = {
      total: 1900 * MB,
      used: 1790 * MB,
      available: 107 * MB,
      percentage: 89.1,
      mount: "/srv/frameos",
      upgradeHeadroom: { needed: 226 * MB, available: 107 * MB },
    };
    expect(labels([sample("2026-09-21T22:00:00Z", { diskUsage })])).toEqual([
      "No room for the next FrameOS update (107 MB free, 226 MB needed)",
    ]);
  });

  it("is quiet while there is room", () => {
    const diskUsage = { percentage: 14, upgradeHeadroom: { needed: 226 * MB, available: 1600 * MB } };
    expect(labels([sample("2026-09-22T01:00:00Z", { diskUsage })])).toEqual([]);
  });

  it("reports the last upgrade when it failed, from the newest sample only", () => {
    const failed = {
      status: "failed",
      latest_version: "2026.9.21",
      message: "Not enough free disk space in /srv/frameos/tmp to unpack the release",
    };
    expect(labels([sample("2026-09-21T23:24:00Z", { upgrade: failed })])).toEqual([
      "FrameOS update to 2026.9.21 failed: Not enough free disk space in /srv/frameos/tmp to unpack the release",
    ]);
    // A later sample that says it went through clears it.
    expect(
      labels([
        sample("2026-09-21T23:24:00Z", { upgrade: failed }),
        sample("2026-09-22T01:32:00Z", { upgrade: { status: "success", latest_version: "2026.9.21" } }),
      ]),
    ).toEqual([]);
  });
});

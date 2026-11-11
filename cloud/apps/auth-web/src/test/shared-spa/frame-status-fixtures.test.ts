// The frames list's words for a frame (status word, the line under its name,
// the deploy bar, the firmware word) come from the SPA's decorators, and the
// iOS app draws the same row from its own ports of them
// (ios/FrameOSKit/Sources/FrameOSKit/Contracts/FrameStatus.swift). Both
// replay docs/frame-status-fixtures.json, so a change to one that the other
// does not follow is a red test on one side or the other.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mode = vi.hoisted(() => ({ cloud: false }));
vi.mock("../../../../../../frontend/src/utils/cloudMode", () => ({
  isCloudMode: () => mode.cloud,
  cloudSignedIn: () => mode.cloud,
  isCloudPublicStore: () => false,
}));

import {
  frameActivityDescription,
  frameDeployProgress,
  frameFirmwareUpdateProgress,
  frameStatusLabel,
} from "../../../../../../frontend/src/decorators/frame";
import type { FrameType } from "../../../../../../frontend/src/types";

type Case = {
  name: string;
  plane: "cloud" | "backend";
  frame: Record<string, unknown>;
  expect: {
    label: string;
    activity: string;
    deploy: { status: string; label: string; caption: string; percent: number } | null;
    firmware: { kind: string; label: string; percent: number | null } | null;
  };
};

const fixtures = JSON.parse(
  readFileSync(join(__dirname, "../../../../../../docs/frame-status-fixtures.json"), "utf8"),
) as { now: string; cases: Case[] };
const now = Date.parse(fixtures.now);

describe("docs/frame-status-fixtures.json", () => {
  beforeEach(() => vi.useFakeTimers({ now }));
  afterEach(() => {
    vi.useRealTimers();
    mode.cloud = false;
  });

  for (const kase of fixtures.cases) {
    it(kase.name, () => {
      mode.cloud = kase.plane === "cloud";
      const frame = kase.frame as unknown as FrameType;
      const deploy = frameDeployProgress(frame, now);
      const firmware = frameFirmwareUpdateProgress(frame, now);
      expect({
        label: frameStatusLabel(frame),
        activity: frameActivityDescription(frame),
        deploy: deploy && { status: deploy.status, label: deploy.label, caption: deploy.caption, percent: deploy.percent },
        firmware: firmware && { kind: firmware.kind, label: firmware.label, percent: firmware.percent },
      }).toEqual(kase.expect);
    });
  }
});

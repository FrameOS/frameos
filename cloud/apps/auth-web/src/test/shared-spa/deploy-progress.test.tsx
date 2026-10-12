// The control planes record how far a deploy, update, restart or reboot has
// come in `deploy_progress` (docs/deploy-progress-contract.json);
// frameDeployProgress turns that record into the bar the frames list draws
// under the frame's name instead of "last seen just now". Pure functions
// over the generated contract tables, tested from auth-web like the other
// shared-SPA logic. The stale and percent sections of the contract's own
// corpus replay here too, so the SPA's reading of a record cannot drift
// from the backend's and the cloud's.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeployProgressBar, DeployProgressSteps } from "../../../../../../frontend/src/components/DeployProgressBar";
import {
  frameActivityDescription,
  frameDeployProgress,
  frameDeployProgressIsRunning,
  frameDeployProgressSteps,
} from "../../../../../../frontend/src/decorators/frame";
import type { FrameDeployProgress, FrameType } from "../../../../../../frontend/src/types";
import { deployProgressContract } from "../../../../../../frontend/src/utils/deployProgress.gen";

const now = Date.parse("2026-10-12T12:00:00Z");
const at = (secondsAgo: number) => new Date(now - secondsAgo * 1000).toISOString();

type Fixtures = {
  stale: Array<{
    kind: string;
    stage: string;
    ageSeconds: number;
    nextWakeInSeconds?: number;
    status?: "done" | "error";
    expect: boolean;
  }>;
  percent: Array<{
    kind: string;
    stage: string;
    status?: "done";
    progress?: { current: number; total: number };
    expect: number;
  }>;
};

const fixtures: Fixtures = JSON.parse(
  readFileSync(join(__dirname, "../../../../../../docs/deploy-progress-fixtures.json"), "utf8"),
);

function record(fields: Partial<FrameDeployProgress> & { kind: string; stage: string }): FrameDeployProgress {
  return {
    id: "deploy:1",
    status: "running",
    detail: null,
    progress: null,
    version: null,
    error: null,
    started_at: at(60),
    at: at(5),
    ...fields,
  };
}

const frame = (deploy_progress: FrameDeployProgress | null, rest: Partial<FrameType> = {}): FrameType =>
  ({
    id: 1,
    name: "Kitchen",
    status: "ready",
    last_log_at: at(3600),
    last_successful_deploy_at: at(7200),
    ...rest,
    deploy_progress,
  }) as unknown as FrameType;

describe("frameDeployProgress", () => {
  // frameActivityDescription and fleetUpdateInFlight read the wall clock.
  beforeEach(() => vi.useFakeTimers({ now }));
  afterEach(() => vi.useRealTimers());

  it("draws the bar from the kind's stage order", () => {
    const view = frameDeployProgress(frame(record({ kind: "linux_full", stage: "installing", detail: "frameos setup" })), now);
    expect(view).toMatchObject({
      kind: "linux_full",
      kindLabel: "Deploy FrameOS, scenes & settings",
      status: "running",
      label: "installing",
      caption: "installing · frameos setup",
      percent: 54,
    });
    expect(view?.title).toBe("Deploy FrameOS, scenes & settings · installing · frameos setup");
  });

  it("shows the download's bytes inside its stage", () => {
    const view = frameDeployProgress(
      frame(record({ kind: "esp32_full", stage: "downloading", progress: { current: 50, total: 100 } })),
      now,
    );
    expect(view).toMatchObject({ caption: "downloading · 50%", percent: 36 });
  });

  it("is nothing once the record sat in its stage longer than the stage allows", () => {
    const booting = deployProgressContract.stages.booting.staleAfterSeconds;
    expect(frameDeployProgress(frame(record({ kind: "linux_full", stage: "booting", at: at(booting - 1) })), now)).not.toBeNull();
    expect(frameDeployProgress(frame(record({ kind: "linux_full", stage: "booting", at: at(booting + 1) })), now)).toBeNull();
  });

  it("keeps a queued deploy believable while the frame's own wake is still ahead", () => {
    const old = record({ kind: "esp32_fast", stage: "waiting", at: at(2 * 3600) });
    expect(frameDeployProgress(frame(old), now)).toBeNull();
    expect(frameDeployProgress(frame(old, { next_wake_at: new Date(now + 1800 * 1000).toISOString() }), now)).toMatchObject({
      label: "waiting for the frame",
    });
  });

  it("says deployed for a few seconds, failed for a few minutes, then forgets", () => {
    const done = record({ kind: "linux_fast", stage: "done", status: "done", at: at(5) });
    expect(frameDeployProgress(frame(done), now)).toMatchObject({ status: "done", label: "deployed", percent: 100 });
    expect(frameDeployProgress(frame({ ...done, at: at(deployProgressContract.record.doneShownSeconds + 1) }), now)).toBeNull();
    const restarted = record({ kind: "restart", stage: "done", status: "done", at: at(2) });
    expect(frameDeployProgress(frame(restarted), now)?.caption).toBe("restarted");
    const failed = record({ kind: "linux_full", stage: "building", status: "error", error: "cross compile failed", at: at(60) });
    expect(frameDeployProgress(frame(failed), now)).toMatchObject({
      status: "error",
      caption: "failed: cross compile failed",
      percent: 29,
    });
    expect(frameDeployProgress(frame({ ...failed, at: at(deployProgressContract.record.errorShownSeconds + 1) }), now)).toBeNull();
  });

  it("ignores a record of a kind or stage the contract does not know", () => {
    expect(frameDeployProgress(frame(record({ kind: "teleport", stage: "queued" })), now)).toBeNull();
    expect(frameDeployProgress(frame(record({ kind: "virtual", stage: "building" })), now)).toBeNull();
    expect(frameDeployProgress(frame(null), now)).toBeNull();
  });

  it("is the row's text while running", () => {
    const deploying = frame(record({ kind: "linux_full", stage: "uploading" }));
    expect(frameDeployProgressIsRunning(deploying, now)).toBe(true);
    expect(frameActivityDescription(deploying)).toBe("uploading");
    const idle = frame(null);
    expect(frameDeployProgressIsRunning(idle, now)).toBe(false);
    expect(frameActivityDescription(idle)).toBe("last seen 1 hour ago");
  });
});

describe("the contract's corpus", () => {
  for (const kase of fixtures.stale) {
    it(`stale: ${kase.kind} ${kase.stage} after ${kase.ageSeconds}s${kase.nextWakeInSeconds !== undefined ? ` (wake in ${kase.nextWakeInSeconds}s)` : ""} -> ${kase.expect}`, () => {
      const rec = record({
        kind: kase.kind,
        stage: kase.status === "done" ? "done" : kase.stage,
        status: kase.status ?? "running",
        error: kase.status === "error" ? "boom" : null,
        at: at(kase.ageSeconds),
      });
      const view = frameDeployProgress(
        frame(rec, kase.nextWakeInSeconds !== undefined ? { next_wake_at: new Date(now + kase.nextWakeInSeconds * 1000).toISOString() } : {}),
        now,
      );
      // A finished record is never "stale"; the view forgets it on its own
      // clock (doneShownSeconds / errorShownSeconds), which these cases do
      // not pin. A running one that went stale is exactly a null view.
      if (kase.status === undefined) {
        expect(view === null).toBe(kase.expect);
      }
    });
  }
  for (const kase of fixtures.percent) {
    it(`percent: ${kase.kind} ${kase.stage} -> ${kase.expect}`, () => {
      const rec = record({
        kind: kase.kind,
        stage: kase.stage,
        status: kase.status ?? "running",
        progress: kase.progress ?? null,
      });
      expect(frameDeployProgress(frame(rec), now)?.percent).toBe(kase.expect);
    });
  }
});

describe("DeployProgressBar", () => {
  it("renders the caption, the percentage and a filled track", () => {
    const view = frameDeployProgress(frame(record({ kind: "linux_full", stage: "installing", detail: "frameos setup" })), now);
    const html = renderToStaticMarkup(<DeployProgressBar progress={view!} />);
    expect(html).toContain('role="progressbar"');
    expect(html).toContain("installing · frameos setup");
    expect(html).toContain("54%");
    expect(html).toContain("width:54%");
  });

  it("colours a failure red and drops the percentage", () => {
    const view = frameDeployProgress(
      frame(record({ kind: "esp32_fast", stage: "waiting", status: "error", error: "scene store full", at: at(1) })),
      now,
    );
    const html = renderToStaticMarkup(<DeployProgressBar progress={view!} />);
    expect(html).toContain("failed: scene store full");
    expect(html).toContain("bg-red-400");
    expect(html).not.toMatch(/\d+%<\/span>/);
  });
});

describe("frameDeployProgressSteps", () => {
  it("marks the kind's stages done, current and pending", () => {
    const steps = frameDeployProgressSteps(
      frame(record({ kind: "linux_fast", stage: "reloading", detail: "the runtime re-reads its files" })),
      now,
    );
    expect(steps.map((step) => [step.stage, step.state])).toEqual([
      ["queued", "done"],
      ["connecting", "done"],
      ["uploading", "done"],
      ["installing", "done"],
      ["reloading", "current"],
      ["booting", "pending"],
      ["rendering", "pending"],
    ]);
    expect(steps[4]).toMatchObject({ label: "Reloading", detail: "reloading · the runtime re-reads its files" });
    expect(steps[6]?.label).toBe("First render");
  });

  it("marks where a deploy failed, and everything once it is done", () => {
    const failed = frameDeployProgressSteps(
      frame(record({ kind: "esp32_fast", stage: "receiving", status: "error", error: "scene store full", at: at(1) })),
      now,
    );
    expect(failed.find((step) => step.state === "error")).toMatchObject({ stage: "receiving", detail: "scene store full" });
    const done = frameDeployProgressSteps(frame(record({ kind: "reboot", stage: "done", status: "done", at: at(1) })), now);
    expect(done.every((step) => step.state === "done")).toBe(true);
    expect(frameDeployProgressSteps(frame(null), now)).toEqual([]);
  });

  it("renders the list with a spinner on the current step", () => {
    const deploying = frame(record({ kind: "restart", stage: "restarting" }));
    const html = renderToStaticMarkup(
      <DeployProgressSteps progress={frameDeployProgress(deploying, now)!} steps={frameDeployProgressSteps(deploying, now)} />,
    );
    expect(html).toContain("Restart FrameOS");
    expect(html).toContain('data-deploy-step="restarting" data-state="current"');
    expect(html).toContain('role="status"');
  });
});

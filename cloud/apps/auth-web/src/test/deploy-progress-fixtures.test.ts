// The cloud's runner of docs/deploy-progress-fixtures.json, the conformance
// corpus of the deploy-progress contract (docs/deploy-progress-contract.json,
// docs/deploy-progress.md). The self-hosted backend
// (backend/app/utils/tests/test_deploy_progress.py) replays the same file
// against its own fold, and the shared SPA's reading of a record
// (shared-spa/deploy-progress.test.tsx) replays its stale and percent
// sections — a case green on one plane and red on another is the planes
// drifting.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  advanceDeployProgress,
  deployProgressIsStale,
  deployProgressKindForCommand,
  deployProgressPercent,
  failDeployProgress,
  finishDeployProgress,
  foldDeployProgress,
  foldDeployProgressCommand,
  foldDeployProgressLog,
  isDeployProgressRecord,
  startDeployProgress,
  type DeployProgressRecord,
} from "../lib/deploy-progress";
import type { DeployProgressKind } from "../lib/deploy-progress.gen";

interface Step {
  advance?: string;
  signal?: string;
  log?: Record<string, unknown>;
  command?: { type: string; state: string; error?: string };
  finish?: boolean;
  fail?: string;
  detail?: string;
  expect?: Record<string, unknown>;
}

interface Fixtures {
  cases: Array<{ name: string; kind: string; start?: { stage?: string }; steps: Step[] }>;
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
}

const fixtures = JSON.parse(
  readFileSync(new URL("../../../../../docs/deploy-progress-fixtures.json", import.meta.url), "utf8"),
) as Fixtures;

const start = new Date("2026-10-12T12:00:00Z");

function apply(record: DeployProgressRecord, step: Step, now: Date): DeployProgressRecord | undefined {
  if (step.advance !== undefined) {
    return advanceDeployProgress(record, step.advance, { now, detail: step.detail ?? null });
  }
  if (step.signal !== undefined) {
    return foldDeployProgress(record, step.signal, { now, detail: step.detail ?? null });
  }
  if (step.log !== undefined) {
    return foldDeployProgressLog(record, step.log, { now });
  }
  if (step.command !== undefined) {
    return foldDeployProgressCommand(record, step.command.type, step.command.state, {
      now,
      error: step.command.error ?? null,
    });
  }
  if (step.finish !== undefined) {
    return finishDeployProgress(record, { now, detail: step.detail ?? null });
  }
  if (step.fail !== undefined) {
    return failDeployProgress(record, step.fail, { now });
  }
  return undefined;
}

describe("deploy-progress fixtures", () => {
  for (const kase of fixtures.cases) {
    it(kase.name, () => {
      let record = startDeployProgress(kase.kind as DeployProgressKind, {
        id: "fixture",
        now: start,
        ...(kase.start?.stage ? { stage: kase.start.stage } : {}),
      });
      let now = start;
      kase.steps.forEach((step, index) => {
        now = new Date(now.getTime() + 1000);
        const moved = apply(record, step, now);
        const expected = step.expect ?? {};
        const where = `${kase.name} step ${index}`;
        const acts = ["advance", "signal", "log", "command", "finish", "fail"].some((key) => key in step);
        if (expected.changed === false) {
          expect(moved, `${where}: expected no change`).toBeUndefined();
        } else if (acts) {
          expect(moved, `${where}: expected a change`).toBeDefined();
        }
        if (moved) {
          record = moved;
        }
        for (const key of ["stage", "status", "detail", "error", "progress"] as const) {
          if (key in expected) {
            expect(record[key], `${where}: ${key}`).toEqual(expected[key]);
          }
        }
      });
    });
  }

  for (const kase of fixtures.stale) {
    it(`stale: ${kase.kind} ${kase.stage} after ${kase.ageSeconds}s -> ${kase.expect}`, () => {
      let record: DeployProgressRecord | undefined = startDeployProgress(kase.kind as DeployProgressKind, {
        id: "fixture",
        now: start,
        stage: kase.stage,
      });
      if (kase.status === "done") {
        record = finishDeployProgress(record, { now: start });
      } else if (kase.status === "error") {
        record = failDeployProgress(record, "boom", { now: start });
      }
      const now = new Date(start.getTime() + kase.ageSeconds * 1000);
      const nextWakeAt =
        kase.nextWakeInSeconds === undefined ? null : new Date(now.getTime() + kase.nextWakeInSeconds * 1000);
      expect(deployProgressIsStale(record, now, { nextWakeAt })).toBe(kase.expect);
    });
  }

  for (const kase of fixtures.percent) {
    it(`percent: ${kase.kind} ${kase.stage} -> ${kase.expect}`, () => {
      let record: DeployProgressRecord | undefined;
      if (kase.status === "done") {
        record = finishDeployProgress(startDeployProgress(kase.kind as DeployProgressKind, { id: "x", now: start }), {
          now: start,
        });
      } else {
        record = {
          ...startDeployProgress(kase.kind as DeployProgressKind, { id: "x", now: start, stage: kase.stage }),
          progress: kase.progress ?? null,
        };
      }
      expect(deployProgressPercent(record)).toBe(kase.expect);
    });
  }
});

describe("deploy-progress helpers", () => {
  it("maps the queued verbs onto kinds by device profile", () => {
    expect(deployProgressKindForCommand("set_scenes", "esp32")).toBe("cloud_scenes");
    expect(deployProgressKindForCommand("notify_update_available", "esp32")).toBe("firmware");
    expect(deployProgressKindForCommand("notify_update_available", "linux")).toBe("upgrade");
    expect(deployProgressKindForCommand("reboot", "linux")).toBe("reboot");
    expect(deployProgressKindForCommand("restart_runtime", "esp32")).toBe("restart");
    expect(deployProgressKindForCommand("set_settings", "linux")).toBeUndefined();
    expect(deployProgressKindForCommand("render", "linux")).toBeUndefined();
  });

  it("only a kind-matched advance moves a record when a kind is named", () => {
    const record = startDeployProgress("restart", { id: "x", now: start });
    expect(advanceDeployProgress(record, "restarting", { now: start, kind: "reboot" })).toBeUndefined();
    expect(advanceDeployProgress(record, "restarting", { now: start, kind: "restart" })?.stage).toBe("restarting");
  });

  it("rejects what is not a record", () => {
    expect(isDeployProgressRecord(null)).toBe(false);
    expect(isDeployProgressRecord({ kind: "linux_full" })).toBe(false);
    expect(isDeployProgressRecord({ kind: "nope", stage: "queued", status: "running" })).toBe(false);
    expect(isDeployProgressRecord(startDeployProgress("virtual", { id: "x", now: start }))).toBe(true);
    expect(() => startDeployProgress("virtual", { id: "x", now: start, stage: "building" })).toThrow();
  });
});

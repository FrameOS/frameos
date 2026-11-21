// The cloud's runner of docs/update-decision-fixtures.json: the update
// decision shared with the backend (backend/app/utils/tests/
// test_update_decision.py) and the Linux runtime
// (frameos/src/frameos/tests/test_update_decision.nim).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  cohortBucket,
  decideUpdate,
  parseTime,
  parseVersion,
  rolloutPercent,
  versionText,
} from "./update-decision";

interface Fixtures {
  defaultRollout: unknown;
  versions: { input: string; version: string | null }[];
  buckets: { frameKey: string; version: string; bucket: number }[];
  rollout: { release: Record<string, unknown>; now: string; percent: number }[];
  manifests: Record<string, unknown>;
  decisions: {
    name: string;
    manifest: string | null;
    request: Record<string, unknown>;
    expect: {
      version: string | null;
      reason: string;
      latest: string | null;
      held: { version: string; why: string } | null;
    };
  }[];
}

const fixtures = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../../../docs/update-decision-fixtures.json", import.meta.url)), "utf8"),
) as Fixtures;

describe("update decision fixtures", () => {
  it.each(fixtures.versions)("parses version $input", ({ input, version }) => {
    const parsed = parseVersion(input);
    expect(parsed ? versionText(parsed) : null).toBe(version);
  });

  it.each(fixtures.buckets)("buckets $frameKey/$version", ({ frameKey, version, bucket }) => {
    expect(cohortBucket(frameKey, version)).toBe(bucket);
  });

  it.each(fixtures.rollout)("rollout of $release.at at $now", ({ release, now, percent }) => {
    const moment = parseTime(now);
    expect(moment).not.toBeNull();
    expect(rolloutPercent(release, fixtures.defaultRollout, moment!)).toBe(percent);
  });

  it.each(fixtures.decisions)("$name", ({ manifest, request, expect: expected }) => {
    const got = decideUpdate(manifest ? fixtures.manifests[manifest] : null, request);
    expect({
      version: got.version,
      reason: got.reason,
      latest: got.latest,
      held: got.held ? { version: got.held.version, why: got.held.why } : null,
    }).toEqual(expected);
    if (got.held) {
      expect(typeof got.held.detail).toBe("string");
      expect(got.held.detail.length).toBeGreaterThan(0);
    }
  });
});

describe("parseTime", () => {
  it("reads a bare time as UTC and refuses an impossible date", () => {
    expect(parseTime("2026-12-20T00:00:00")).toBe(Date.UTC(2026, 11, 20) / 1000);
    expect(parseTime("2026-02-30T00:00:00Z")).toBeNull();
    expect(parseTime("2026-12-20")).toBe(Date.UTC(2026, 11, 20) / 1000);
  });
});

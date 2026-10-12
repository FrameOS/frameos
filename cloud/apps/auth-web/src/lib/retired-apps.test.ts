import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { RETIRED_APPS } from "./retired-apps.gen";
import {
  keywordsRuntimeLacks,
  replacementAppEntry,
  restoreAppsInScenes,
  retireAppsInScenes,
  scenesForRuntime,
  withRetiredAppsReplaced,
} from "./retired-apps";

const repoRoot = join(__dirname, "..", "..", "..", "..", "..");
const contract = JSON.parse(readFileSync(join(repoRoot, "docs", "retired-apps.json"), "utf8"));
const fixtures = JSON.parse(readFileSync(join(repoRoot, "docs", "retired-apps-fixtures.json"), "utf8"));

type Case = {
  name: string;
  op: "retire" | "restore" | "forRuntime";
  runtimeVersion?: string | null;
  input: unknown[];
  output: unknown[];
};

// Swap the fixtures' "@repo/apps/code/<app>" placeholders for the real entry.
function expand(value: unknown): unknown {
  if (typeof value === "string" && value.startsWith("@repo/")) {
    return replacementAppEntry(value.slice(1));
  }
  if (Array.isArray(value)) {
    return value.map(expand);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expand(item)]));
  }
  return value;
}

describe("retired apps (docs/retired-apps-fixtures.json)", () => {
  it("carries the contract's table", () => {
    expect(RETIRED_APPS).toEqual(contract.apps);
  });

  for (const testCase of fixtures.cases as Case[]) {
    it(testCase.name, () => {
      const scenes = expand(testCase.input) as unknown[];
      const original = structuredClone(scenes);
      let result: unknown[];
      if (testCase.op === "retire") {
        retireAppsInScenes(scenes);
        result = scenes;
      } else if (testCase.op === "restore") {
        restoreAppsInScenes(scenes);
        result = scenes;
      } else {
        result = scenesForRuntime(scenes, testCase.runtimeVersion);
        // A copy for the device: what was read is never touched.
        expect(scenes).toEqual(original);
      }
      expect(result).toEqual(expand(testCase.output));
    });
  }

  it("the generated replacement is the repo app", () => {
    const entry = replacementAppEntry("repo/apps/code/immich");
    const sources = entry.sources as Record<string, string>;
    expect(entry.origin).toBe("repo/apps/code/immich");
    expect(entry.settings).toEqual(["immich"]);
    expect(sources["app.ts"]).toBe(readFileSync(join(repoRoot, "repo/apps/code/immich/app.ts"), "utf8"));
  });

  it("knows which runtimes lack the replacement", () => {
    expect(keywordsRuntimeLacks("2026.10.10")).toEqual(["data/immich"]);
    expect(keywordsRuntimeLacks("v2026.10.10+abc")).toEqual(["data/immich"]);
    expect(keywordsRuntimeLacks("2026.10.11")).toEqual([]);
    expect(keywordsRuntimeLacks(null)).toEqual([]);
    expect(keywordsRuntimeLacks("nightly")).toEqual([]);
  });

  it("converts a copy for readers", () => {
    const stored = [{ id: "s", nodes: [{ id: "a", type: "app", data: { keyword: "data/immich", config: {} } }] }];
    const read = withRetiredAppsReplaced(stored);
    expect(read[0]?.nodes[0]?.data.keyword).toBe("immich");
    expect(stored[0]?.nodes[0]?.data.keyword).toBe("data/immich");
  });
});

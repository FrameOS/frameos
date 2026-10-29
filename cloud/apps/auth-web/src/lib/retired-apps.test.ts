import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { RETIRED_APPS } from "./retired-apps.gen";
import {
  isAppTestFile,
  keywordsRuntimeLacks,
  replacementAppEntry,
  restoreAppsInScenes,
  retireAppsInScenes,
  scenesForEmbeddedRuntime,
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

// Swap the fixtures' "@repo/apps/<folder>/<app>" placeholders for the real entry.
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
    const entry = replacementAppEntry("repo/apps/image/immich");
    const sources = entry.sources as Record<string, string>;
    expect(entry.origin).toBe("repo/apps/image/immich");
    expect(entry.settings).toEqual(["immich"]);
    expect(sources["app.ts"]).toBe(readFileSync(join(repoRoot, "repo/apps/image/immich/app.ts"), "utf8"));
  });

  it("knows which runtimes lack the replacement", () => {
    expect(keywordsRuntimeLacks("2026.10.10")).toEqual(["data/immich", "data/frameOSGallery", "data/unsplash", "data/wikicommons", "data/googlePhotos", "data/openaiImage", "data/openaiText", "data/haSensor", "data/weather", "data/beRecycle", "render/chart", "data/eventsToAgenda"]);
    expect(keywordsRuntimeLacks("v2026.10.10+abc")).toEqual(["data/immich", "data/frameOSGallery", "data/unsplash", "data/wikicommons", "data/googlePhotos", "data/openaiImage", "data/openaiText", "data/haSensor", "data/weather", "data/beRecycle", "render/chart", "data/eventsToAgenda"]);
    expect(keywordsRuntimeLacks("2026.10.12")).toEqual(["data/frameOSGallery", "data/unsplash", "data/wikicommons", "data/googlePhotos", "data/openaiImage", "data/beRecycle", "render/chart", "data/eventsToAgenda"]);
    expect(keywordsRuntimeLacks("2026.10.11")).toEqual(["data/frameOSGallery", "data/unsplash", "data/wikicommons", "data/googlePhotos", "data/openaiImage", "data/beRecycle", "render/chart", "data/eventsToAgenda"]);
    // 2026.10.22 is the first release without the Nim agenda.
    expect(keywordsRuntimeLacks("2026.10.13")).toEqual(["data/eventsToAgenda"]);
    expect(keywordsRuntimeLacks("2026.10.21")).toEqual(["data/eventsToAgenda"]);
    expect(keywordsRuntimeLacks("2026.10.22")).toEqual([]);
    expect(keywordsRuntimeLacks(null)).toEqual([]);
    expect(keywordsRuntimeLacks("nightly")).toEqual([]);
  });

  it("an embedded runtime gets no app test files", () => {
    const scenes = [
      {
        apps: {
          panel: { sources: { "app.ts": "x", "app.test.ts": "y", "util.TEST.jsx": "z", "config.json": "{}" } },
          odd: { sources: "not a map" },
        },
        id: "a",
      },
      { id: "b" },
    ];
    expect(isAppTestFile("app.test.ts")).toBe(true);
    expect(isAppTestFile("app.ts")).toBe(false);
    expect(isAppTestFile("test.ts")).toBe(false);
    const stripped = scenesForEmbeddedRuntime(scenes, "2026.10.15");
    expect((stripped[0] as (typeof scenes)[0]).apps!.panel!.sources).toEqual({ "app.ts": "x", "config.json": "{}" });
    expect(Object.keys(scenes[0]!.apps!.panel!.sources)).toContain("app.test.ts");
  });

  it("converts a copy for readers", () => {
    const stored = [{ id: "s", nodes: [{ id: "a", type: "app", data: { keyword: "data/immich", config: {} } }] }];
    const read = withRetiredAppsReplaced(stored);
    expect(read[0]?.nodes[0]?.data.keyword).toBe("immich");
    expect(stored[0]?.nodes[0]?.data.keyword).toBe("data/immich");
  });
});

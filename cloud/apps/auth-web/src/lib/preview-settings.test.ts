import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  paidServicesForScenes,
  previewSettingsGroups,
  requiredSettingsForScenes,
} from "./preview-settings";

const repoRoot = join(__dirname, "..", "..", "..", "..", "..");

function groupKeys(scenes: Record<string, unknown>[]): string[] {
  return requiredSettingsForScenes(scenes).map((group) => group.key);
}

// Which settings a scene needs decides which API keys the preview asks for —
// and, once service-settings delivery lands, which of the account's keys a
// frame is sent. Both directions are wrong if this misreads a scene, so it
// mirrors get_frame_json in backend/app/models/frame.py exactly.
describe("requiredSettingsForScenes", () => {
  it("reads the keyword table for stock apps", () => {
    expect(
      groupKeys([
        {
          nodes: [
            { type: "app", data: { keyword: "data/unsplash" } },
            { type: "app", data: { keyword: "data/haSensor" } },
          ],
        },
      ]),
    ).toEqual(["homeAssistant", "unsplash"]);
  });

  it("ignores non-app nodes", () => {
    // A code node whose keyword happens to collide must not pull in keys.
    expect(
      groupKeys([
        {
          nodes: [
            { type: "code", data: { keyword: "data/unsplash" } },
            { type: "event", data: {} },
          ],
        },
      ]),
    ).toEqual([]);
  });

  it("reads an edited app's config.json out of sources, on the node", () => {
    // Real scene JSON stores this as a JSON STRING under
    // sources["config.json"]. The old code read `.config.settings`, an object
    // that never exists, so every custom app was silently missed.
    expect(
      groupKeys([
        {
          nodes: [
            {
              type: "app",
              data: {
                keyword: "custom/mine",
                sources: {
                  "config.json": JSON.stringify({ settings: ["openAI"] }),
                },
              },
            },
          ],
        },
      ]),
    ).toEqual(["openAI"]);
  });

  it("falls back to the scene's apps map for the sources", () => {
    expect(
      groupKeys([
        {
          nodes: [{ type: "app", data: { keyword: "weatherPanel" } }],
          apps: {
            weatherPanel: {
              sources: {
                "config.json": JSON.stringify({ settings: ["immich"] }),
              },
            },
          },
        },
      ]),
    ).toEqual(["immich"]);
  });

  it("treats embedded sources as authoritative, not additive", () => {
    // An edited copy of a stock app that dropped its dependency must not keep
    // the keyword table's entry — the backend takes the same either/or branch.
    expect(
      groupKeys([
        {
          nodes: [
            {
              type: "app",
              data: {
                keyword: "data/unsplash",
                sources: { "config.json": JSON.stringify({ settings: [] }) },
              },
            },
          ],
        },
      ]),
    ).toEqual([]);
  });

  it("survives unparseable or oddly shaped sources", () => {
    expect(
      groupKeys([
        {
          nodes: [
            {
              type: "app",
              data: { keyword: "a", sources: { "config.json": "{not json" } },
            },
            {
              type: "app",
              data: {
                keyword: "b",
                sources: { "config.json": JSON.stringify({ settings: "no" }) },
              },
            },
            {
              type: "app",
              data: {
                keyword: "c",
                sources: { "config.json": JSON.stringify({ settings: [7] }) },
              },
            },
            // sources present but without a config.json: not a fallback case
            { type: "app", data: { keyword: "d", sources: { "app.js": "" } } },
          ],
        },
      ]),
    ).toEqual([]);
  });

  it("dedupes across nodes and scenes, in group order", () => {
    expect(
      groupKeys([
        { nodes: [{ type: "app", data: { keyword: "data/openaiImage" } }] },
        {
          nodes: [
            { type: "app", data: { keyword: "data/openaiText" } },
            { type: "app", data: { keyword: "data/frameOSGallery" } },
          ],
        },
      ]),
    ).toEqual(["frameOS", "openAI"]);
  });

  it("tolerates empty and malformed scenes", () => {
    expect(groupKeys([])).toEqual([]);
    expect(groupKeys([{}, { nodes: [] }, { nodes: [{ type: "app" }] }])).toEqual(
      [],
    );
  });
});

// A render in the live preview is a real request to every service the scene
// uses; the paid ones must be flagged so the preview asks before spending.
describe("paidServicesForScenes", () => {
  it("flags OpenAI and nothing else", () => {
    const paid = Object.values(previewSettingsGroups)
      .filter((group) => group.paid)
      .map((group) => group.key);
    expect(paid).toEqual(["openAI"]);
  });

  it("reports the paid services a scene calls, through either detection path", () => {
    const keys = (scenes: Record<string, unknown>[]) =>
      paidServicesForScenes(scenes).map((group) => group.key);
    expect(keys([{ nodes: [{ type: "app", data: { keyword: "data/openaiImage" } }] }])).toEqual(
      ["openAI"],
    );
    expect(
      keys([
        {
          nodes: [
            {
              type: "app",
              data: {
                keyword: "custom/poet",
                sources: { "config.json": JSON.stringify({ settings: ["openAI"] }) },
              },
            },
          ],
        },
      ]),
    ).toEqual(["openAI"]);
    expect(
      keys([
        {
          nodes: [
            { type: "app", data: { keyword: "data/unsplash" } },
            { type: "app", data: { keyword: "data/immich" } },
          ],
        },
      ]),
    ).toEqual([]);
  });
});

// The cloud serves no app catalog (/api/apps returns {}), so the keyword table
// in preview-settings.ts IS the cloud's copy of the apps' config.json files.
// A new app that declares a settings group would otherwise be missed with no
// signal at all — this fails the build instead.
describe("the keyword table vs the apps' own config.json files", () => {
  const appsDir = join(repoRoot, "frameos", "src", "apps");

  function declaredSettingsByKeyword(): Map<string, string[]> {
    const found = new Map<string, string[]>();
    for (const category of readdirSync(appsDir, { withFileTypes: true })) {
      if (!category.isDirectory()) continue;
      const categoryDir = join(appsDir, category.name);
      for (const app of readdirSync(categoryDir, { withFileTypes: true })) {
        if (!app.isDirectory()) continue;
        let raw: string;
        try {
          raw = readFileSync(join(categoryDir, app.name, "config.json"), "utf8");
        } catch {
          continue;
        }
        const settings = (JSON.parse(raw) as { settings?: unknown }).settings;
        if (Array.isArray(settings) && settings.length > 0) {
          found.set(
            `${category.name}/${app.name}`,
            settings.filter((s): s is string => typeof s === "string"),
          );
        }
      }
    }
    return found;
  }

  it("covers every app that declares settings", () => {
    const declared = declaredSettingsByKeyword();
    // Guard the guard: if the layout moves, an empty map would pass silently.
    expect(declared.size).toBeGreaterThan(0);

    for (const [keyword, settings] of declared) {
      const scenes = [{ nodes: [{ type: "app", data: { keyword } }] }];
      const resolved = new Set(groupKeys(scenes));
      for (const setting of settings) {
        // Groups with no preview/account representation are out of scope; the
        // table only has to cover the ones the cloud can actually store.
        if (!previewSettingsGroups[setting]) continue;
        expect(
          resolved.has(setting),
          `${keyword} declares "${setting}" but the keyword table in preview-settings.ts does not`,
        ).toBe(true);
      }
    }
  });
});

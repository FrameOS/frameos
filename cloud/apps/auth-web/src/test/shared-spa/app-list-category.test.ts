// Where an app lists in the scene editor's apps panel and the new node
// picker. The JS catalog (repo/apps/code) holds the four "New … app (JS)"
// starters AND finished apps: Weather, Unsplash and the rest that replaced
// built-in Nim apps (docs/retired-apps.json). The starters list under Code;
// a finished app lists under the category its config.json declares, where
// its Nim predecessor used to be.
import { describe, expect, it } from "vitest";
import { embeddedRepoAppConfigs } from "../../../../../../frontend/src/generated/repoApps";
import { appListCategory } from "../../../../../../frontend/src/utils/sceneApps";

const catalog = embeddedRepoAppConfigs as Record<string, { category?: string }>;

function categoryOf(name: string): string {
  const keyword = `repo/apps/code/${name}`;
  const app = catalog[keyword];
  expect(app, keyword).toBeDefined();
  return appListCategory(keyword, app ?? {});
}

describe("appListCategory", () => {
  it("lists the JS starters under Code", () => {
    for (const name of ["jsImage", "jsLogic", "jsSvg", "jsText"]) {
      expect(categoryOf(name), name).toBe("code");
    }
  });

  it("lists a finished JS app under its own category", () => {
    for (const name of ["weather", "unsplash", "frameOSGallery", "openaiText", "weatherPanel"]) {
      expect(categoryOf(name), name).toBe("data");
    }
  });

  it("lists every non-starter catalog app under the category it declares", () => {
    const starters = new Set(["jsImage", "jsLogic", "jsSvg", "jsText"].map((name) => `repo/apps/code/${name}`));
    for (const [keyword, app] of Object.entries(catalog)) {
      if (!starters.has(keyword)) {
        expect(appListCategory(keyword, app), keyword).toBe(app.category);
      }
    }
  });

  it("lists a built-in app under its category, lowercased, and one without as other", () => {
    expect(appListCategory("render/image", { category: "Render" })).toBe("render");
    expect(appListCategory("data/clock", {})).toBe("other");
  });
});

// A scene's icon (frontend/src/utils/sceneIcon.ts, docs/scene-icons.md): one
// SVG path in a 0 0 24 24 box; and its category, a name (utils/sceneCategory.ts).
// docs/scene-icon-fixtures.json and docs/scene-category-fixtures.json are
// replayed here and by the runtime (frameos/src/frameos/tests/test_scene_icon.nim),
// so the editor and every frame agree on what is an icon and a category.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  SCENE_ICON_MAX_LENGTH,
  parsePathData,
  sceneIconFromInput,
  sceneIconOf,
  sceneIconPath,
  sceneIconProblem,
  templateSceneIcon,
} from "../../../../../../frontend/src/utils/sceneIcon";
import {
  SCENE_CATEGORY_MAX_LENGTH,
  sceneCategoryFromSelect,
  sceneCategoryName,
  sceneCategoryOptions,
} from "../../../../../../frontend/src/utils/sceneCategory";

interface Fixture {
  name: string;
  icon: unknown;
  path: string | null;
}

const fixtures = JSON.parse(
  readFileSync(new URL("../../../../../../docs/scene-icon-fixtures.json", import.meta.url), "utf8"),
) as { maxLength: number; cases: Fixture[] };

/** `@long-N`: a path of exactly N characters ("M0 0", "h1"s, "z" when N is odd). */
function expand(value: unknown): unknown {
  if (typeof value !== "string" || !value.startsWith("@long-")) {
    return value;
  }
  const length = Number(value.slice("@long-".length));
  let path = "M0 0";
  while (path.length + 2 <= length) {
    path += "h1";
  }
  return path.length < length ? `${path}z` : path;
}

describe("scene icons (docs/scene-icon-fixtures.json)", () => {
  it("has the contract's limit", () => {
    expect(fixtures.maxLength).toBe(SCENE_ICON_MAX_LENGTH);
  });

  for (const fixture of fixtures.cases) {
    it(fixture.name, () => {
      const icon = expand(fixture.icon);
      const path = expand(fixture.path);
      expect(sceneIconPath(icon)).toBe(path);
      // Every value that is no icon, and is not simply absent, says why.
      const absent = icon === null || (typeof icon === "string" && icon.trim() === "");
      expect(sceneIconProblem(icon) === null).toBe(path !== null || absent);
    });
  }
});

describe("the editor's side of it", () => {
  it("explains a refusal in words", () => {
    expect(sceneIconProblem("<svg/>")).toMatch(/path commands and numbers/);
    expect(sceneIconProblem("L1 1")).toMatch(/starts with M/);
    expect(sceneIconProblem("M0 0C1 1")).toMatch(/cannot draw/);
    expect(sceneIconProblem(`M0 0${"h1".repeat(SCENE_ICON_MAX_LENGTH)}`)).toMatch(/at most/);
  });

  it("drops the key when the text box is emptied", () => {
    expect(sceneIconFromInput("")).toBeUndefined();
    expect(sceneIconFromInput("  \n")).toBeUndefined();
    expect(sceneIconFromInput("M0 0 ")).toBe("M0 0 ");
  });

  it("reads a path into its commands, an implicit lineto and arc flags included", () => {
    expect(parsePathData("M1 2 3 4a1 1 0 1020 0z")).toEqual([
      { command: "M", args: [1, 2, 3, 4] },
      { command: "a", args: [1, 1, 0, 1, 0, 20, 0] },
      { command: "z", args: [] },
    ]);
    expect(parsePathData("M1 2a1 1 0 2 0 3 3")).toBeNull();
  });

  it("finds a scene's icon, and a saved scene's main scene's", () => {
    expect(sceneIconOf({ settings: { icon: " M12 2L2 22h20z" } })).toBe("M12 2L2 22h20z");
    expect(sceneIconOf({ settings: { icon: "nope" } })).toBeNull();
    expect(sceneIconOf(null)).toBeNull();
    const first = { settings: { icon: "M0 0h1z" } };
    const scenes = [first, { default: true, settings: { icon: "M1 1h1z" } }];
    expect(templateSceneIcon({ scenes })).toBe("M1 1h1z");
    expect(templateSceneIcon({ scenes: [first] })).toBe("M0 0h1z");
    expect(templateSceneIcon({})).toBeNull();
  });
});

const categories = JSON.parse(
  readFileSync(new URL("../../../../../../docs/scene-category-fixtures.json", import.meta.url), "utf8"),
) as { maxLength: number; cases: { name: string; value: unknown; category: string | null }[] };

describe("scene categories (docs/scene-category-fixtures.json)", () => {
  it("has the contract's limit", () => {
    expect(categories.maxLength).toBe(SCENE_CATEGORY_MAX_LENGTH);
  });

  for (const fixture of categories.cases) {
    it(fixture.name, () => {
      expect(sceneCategoryName(fixture.value)).toBe(fixture.category);
    });
  }

  it("offers the store's titles, a layout the layout ones, and keeps a name of the scene's own", () => {
    const scene = sceneCategoryOptions(undefined, false).map((option) => option.value);
    expect(scene[0]).toBe("");
    expect(scene).toContain("Photos");
    expect(scene).toContain("Real time");
    expect(scene).not.toContain("Desktop layouts");
    expect(sceneCategoryOptions(undefined, true).map((option) => option.value)).toEqual([
      "",
      "Desktop layouts",
      "Full screen layouts",
    ]);
    const own = sceneCategoryOptions("Clocks", false);
    expect(own[own.length - 1]).toEqual({ value: "Clocks", label: "Clocks" });
    expect(sceneCategoryFromSelect("")).toBeUndefined();
    expect(sceneCategoryFromSelect("Weather")).toBe("Weather");
  });
});

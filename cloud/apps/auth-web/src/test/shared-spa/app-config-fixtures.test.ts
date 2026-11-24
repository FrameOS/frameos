// What an app's config.json is, for every reader that decides what the app
// may do: the SPA and the cloud read it with parseAppConfig
// (frontend/src/utils/sceneAccess.ts). docs/app-config-fixtures.json is the
// corpus the frame's runtime (test_app_config_fixtures.nim) and the backend
// (test_app_config.py) replay too: a file one of them reads and another does
// not is a permission somebody never saw.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  APP_CONFIG_MAX_DEPTH,
  SCENE_PERMISSIONS,
  parseAppConfig,
  sceneAccess,
  sceneAppConfigProblem,
  scenesAppConfigProblem,
  withAppPermissions,
} from "../../../../../../frontend/src/utils/sceneAccess";
import { declaredSceneGrants, grantsWidenedBy, redPermissionsAsked } from "../../lib/panel-code-grants";
import { detectRiskFlags } from "../../lib/store";

interface ConfigCase {
  name: string;
  text: string | null;
  nest?: number;
  config: boolean;
  permissions?: string[] | null;
  settings?: string[];
}

const corpus = JSON.parse(
  readFileSync(new URL("../../../../../../docs/app-config-fixtures.json", import.meta.url), "utf8"),
) as { maxDepth: number; permissions: string[]; cases: ConfigCase[] };

// `nest`: {"permissions":["frame"],"x":[[…]]} that many containers deep, the
// object included.
function textOf(fixture: ConfigCase): string {
  if (fixture.nest === undefined) {
    return fixture.text ?? "";
  }
  const arrays = fixture.nest - 1;
  return `{"permissions":["frame"],"x":${"[".repeat(arrays)}${"]".repeat(arrays)}}`;
}

function sceneWith(config: string) {
  return {
    id: "s",
    name: "Scene",
    nodes: [{ id: "a", type: "app", data: { keyword: "myApp" } }],
    edges: [],
    apps: { myApp: { sources: { "app.ts": "export function get() { return 1 }", "config.json": config } } },
  };
}

const everything = ["assets", "assets-write", "frame", "code", "store"];

describe("app config.json (docs/app-config-fixtures.json)", () => {
  it("the depth and the permission names are the contract's", () => {
    expect(corpus.maxDepth).toBe(APP_CONFIG_MAX_DEPTH);
    expect(corpus.permissions).toEqual([...SCENE_PERMISSIONS]);
  });

  for (const fixture of corpus.cases) {
    it(fixture.name, () => {
      const text = textOf(fixture);
      const config = parseAppConfig(text);
      expect(config !== null).toBe(fixture.config);
      const scene = sceneWith(text);
      const [app] = sceneAccess(scene).apps;
      if (!fixture.config) {
        // No config: no door saves or publishes it, a save leaves it for its
        // author, and it reads as asking for everything a JavaScript app can
        // be given, never as asking for nothing.
        expect(sceneAppConfigProblem(scene)).toContain('App "myApp" in scene "Scene": config.json is not valid JSON');
        expect(scenesAppConfigProblem([sceneWith("{}"), scene])).not.toBeNull();
        expect(withAppPermissions(scene)).toBe(scene);
        expect(app?.unreadable).toBe(true);
        expect(app?.declared).toBeNull();
        expect(app?.permissions).toEqual(everything);
        expect(detectRiskFlags([scene])).toEqual(everything);
        expect(redPermissionsAsked(declaredSceneGrants(scene))).toEqual(["assets-write", "code", "frame", "store"]);
        expect(grantsWidenedBy(declaredSceneGrants(sceneWith("{}")), declaredSceneGrants(scene))).not.toEqual([]);
        return;
      }
      expect(sceneAppConfigProblem(scene)).toBeNull();
      expect(app?.unreadable).toBeUndefined();
      expect(app?.declared ?? null).toEqual(fixture.permissions ?? null);
      expect(app?.settings).toEqual(fixture.settings);
      expect(declaredSceneGrants(scene).settings).toEqual([...(fixture.settings ?? [])].sort());
    });
  }

  it("a config.json that is no text is no config", () => {
    expect(parseAppConfig(undefined)).toBeNull();
    expect(parseAppConfig(null)).toBeNull();
    expect(parseAppConfig({ permissions: ["frame"] })).toBeNull();
  });

  it("an app with no config.json has nothing wrong with it", () => {
    const scene = { id: "s", nodes: [], apps: { a: { sources: { "app.ts": "export function get() {}" } } } };
    expect(sceneAppConfigProblem(scene)).toBeNull();
    expect(scenesAppConfigProblem("not a list")).toBeNull();
  });

  it("names a node's own files too", () => {
    const scene = {
      id: "s",
      nodes: [{ id: "n", type: "app", data: { keyword: "inline", sources: { "app.ts": "1", "config.json": "{//\n}" } } }],
    };
    expect(sceneAppConfigProblem(scene)).toContain('App "inline"');
  });
});

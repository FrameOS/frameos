// What a scene's apps ask for on the frame (frontend/src/utils/sceneAccess.ts):
// each app's config.json "permissions" and "settings", the tags the SPA and
// the store show for their union, what an update changes in them, and how a
// save fills a JS app's list. docs/scene-access-fixtures.json is the corpus;
// the store's publish-time risk_flags call the same function.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BUILTIN_APP_ACCESS,
  accessChangesAreRisky,
  appPermissionShortfall,
  describeGainedAccess,
  knownSceneAccessFlags,
  sceneAccess,
  sceneAccessChanges,
  sceneAccessFlagChanges,
  sceneAccessFlagLabel,
  sceneAccessFlags,
  withAppPermissions,
} from "../../../../../../frontend/src/utils/sceneAccess";
import { sceneUpdateAccessNotice } from "../../../../../../frontend/src/utils/sceneUpdateAccess";
import { detectRiskFlags } from "../../lib/store";

const repoUrl = (path: string): URL => new URL(`../../../../../../${path}`, import.meta.url);
const repoFile = (path: string): string => readFileSync(repoUrl(path), "utf8");

interface SceneCase {
  name: string;
  scene: unknown;
  flags: string[];
}
interface SetCase {
  name: string;
  scenes: unknown;
  flags: string[];
}
interface ChangeCase {
  name: string;
  before: string[];
  after: string[];
  gained: string[];
  lost: string[];
}
interface StampCase {
  name: string;
  code: string;
  config: string | null;
  onlyMissing?: boolean;
  /** Newer than the backend's frozen 5e2a9c71d4b8 migration, which skips it. */
  afterMigration?: boolean;
  expect: string | null;
}

const corpus = JSON.parse(repoFile("docs/scene-access-fixtures.json")) as {
  scenes: SceneCase[];
  sets: SetCase[];
  changes: ChangeCase[];
  stamps: StampCase[];
};

describe("scene access corpus", () => {
  for (const fixture of corpus.scenes) {
    it(fixture.name, () => {
      expect(sceneAccessFlags([fixture.scene])).toEqual(fixture.flags);
      // The store's risk flags are the same answer.
      expect(detectRiskFlags([fixture.scene])).toEqual(fixture.flags);
    });
  }
  for (const fixture of corpus.sets) {
    it(`set: ${fixture.name}`, () => {
      expect(sceneAccessFlags(fixture.scenes)).toEqual(fixture.flags);
      expect(detectRiskFlags(fixture.scenes)).toEqual(fixture.flags);
    });
  }
  for (const fixture of corpus.changes) {
    it(`changes: ${fixture.name}`, () => {
      const changes = sceneAccessFlagChanges(fixture.before, fixture.after);
      expect({ gained: changes.gained, lost: changes.lost }).toEqual({
        gained: fixture.gained,
        lost: fixture.lost,
      });
    });
  }
  for (const fixture of corpus.stamps) {
    it(`save: ${fixture.name}`, () => {
      const sources: Record<string, string> = { "app.ts": fixture.code };
      if (fixture.config !== null) {
        sources["config.json"] = fixture.config;
      }
      const scene = {
        id: "s",
        nodes: [{ id: "a", type: "app", data: { keyword: "myApp" } }],
        apps: { myApp: { sources } },
      };
      const saved = withAppPermissions(scene, { onlyMissing: fixture.onlyMissing === true });
      if (fixture.expect === null) {
        // Nothing to change: the very same object comes back.
        expect(saved).toBe(scene);
      } else {
        expect(saved.apps.myApp.sources["config.json"]).toBe(fixture.expect);
        // Saving again changes nothing: the list now matches the code.
        expect(withAppPermissions(saved)).toBe(saved);
      }
    });
  }
});

describe("built-in apps", () => {
  // BUILTIN_APP_ACCESS mirrors what the built-in apps' config.json declare
  // (the cloud server cannot read frameos/src/apps): every key, both ways.
  it("matches every config.json under frameos/src/apps", () => {
    const declared: Record<string, { permissions?: string[]; settings?: string[] }> = {};
    const appsRoot = repoUrl("frameos/src/apps/");
    for (const category of readdirSync(appsRoot, { withFileTypes: true })) {
      if (!category.isDirectory()) {
        continue;
      }
      for (const app of readdirSync(new URL(`${category.name}/`, appsRoot), { withFileTypes: true })) {
        const configUrl = new URL(`${category.name}/${app.name}/config.json`, appsRoot);
        if (!app.isDirectory() || !existsSync(configUrl)) {
          continue;
        }
        const config = JSON.parse(readFileSync(configUrl, "utf8")) as {
          permissions?: string[];
          settings?: string[];
        };
        if (config.permissions?.length || config.settings?.length) {
          declared[`${category.name}/${app.name}`] = {
            ...(config.permissions?.length ? { permissions: config.permissions } : {}),
            ...(config.settings?.length ? { settings: config.settings } : {}),
          };
        }
      }
    }
    expect(BUILTIN_APP_ACCESS).toEqual(declared);
  });
});

describe("scene access details", () => {
  it("names a stale list that does not cover the code", () => {
    const access = sceneAccess({
      nodes: [{ id: "a", type: "app", data: { keyword: "clever" } }],
      apps: {
        clever: {
          sources: {
            "app.ts": "frameos.loadAssetImage('a.png'); frameos.writeAsset('b.png', x)",
            "config.json": JSON.stringify({ name: "Clever", permissions: ["files"] }),
          },
        },
      },
    });
    const app = access.apps[0];
    expect(app?.name).toBe("Clever");
    expect(app?.reasons).toEqual(["calls frameos.loadAssetImage", "calls frameos.writeAsset"]);
    // "files" covers reading the assets folder, not writing it.
    expect(app ? appPermissionShortfall(app) : null).toEqual(["assets-write"]);
  });

  it("an app with no list is not short of anything: it runs as before", () => {
    const access = sceneAccess({
      nodes: [{ id: "a", type: "app", data: { keyword: "old" } }],
      apps: { old: { sources: { "app.ts": "frameos.writeAsset('b', x)" } } },
    });
    expect(access.apps[0]?.declared).toBeNull();
    expect(access.apps[0] ? appPermissionShortfall(access.apps[0]) : null).toEqual([]);
  });

  it("orders catalog flags and drops the ones it does not know", () => {
    expect(
      knownSceneAccessFlags(["key:openAI", "assets-write", "assets", "nsfw", "shell", "files", "key:bad name"]),
    ).toEqual(["shell", "files", "assets-write", "key:openAI"]);
    expect(knownSceneAccessFlags(undefined)).toEqual([]);
  });

  it("labels key flags by the service", () => {
    expect(sceneAccessFlagLabel("key:openAI")).toBe("uses OpenAI key");
    expect(sceneAccessFlagLabel("key:homeAssistant")).toBe("uses Home Assistant key");
    expect(sceneAccessFlagLabel("key:somethingNew")).toBe("uses somethingNew key");
  });
});

describe("what an update changes", () => {
  const app = (keyword: string, code: string, config: Record<string, unknown> = {}) => ({
    id: keyword,
    nodes: [{ id: "a", type: "app", data: { keyword } }],
    apps: { [keyword]: { sources: { "app.ts": code, "config.json": JSON.stringify(config) } } },
  });
  const reader = app("reader", "frameos.readAsset('x')");
  const allFiles = { id: "reader", nodes: [{ id: "l", type: "app", data: { keyword: "data/localImage" } }] };
  const writer = app("writer", "frameos.writeAsset('x', y)");
  const haiku = app("reader", "frameos.readAsset('x')", { settings: ["openAI"] });

  it("reads a scene and its new version the same way", () => {
    const changes = sceneAccessChanges(reader, allFiles);
    expect(changes.gained).toEqual(["files"]);
    expect(describeGainedAccess(changes)).toBe("reads all files (was the assets folder only)");
    expect(accessChangesAreRisky(changes)).toBe(true);
  });

  it("compares sets of scenes as a whole", () => {
    const changes = sceneAccessChanges([reader], [reader, writer]);
    expect(changes.gained).toEqual(["assets-write"]);
    expect(describeGainedAccess(changes)).toBe("writes files");
  });

  it("gaining a key says so without a red button", () => {
    const changes = sceneAccessChanges(reader, haiku);
    expect(describeGainedAccess(changes)).toBe("uses OpenAI key");
    expect(accessChangesAreRisky(changes)).toBe(false);
  });

  it("gaining the frame's settings is a red button", () => {
    const changes = sceneAccessChanges(reader, app("reader", "frameos.readAsset('x'); frameos.frame('read', null)"));
    expect(describeGainedAccess(changes)).toBe("changes frame settings");
    expect(accessChangesAreRisky(changes)).toBe(true);
  });

  it("gaining only a read of the assets folder is not a red button", () => {
    const changes = sceneAccessChanges({ id: "a", nodes: [] }, reader);
    expect(describeGainedAccess(changes)).toBe("reads files");
    expect(accessChangesAreRisky(changes)).toBe(false);
  });

  const photos = { sceneIds: ["p1", "p2"], name: "Photos", changes: sceneAccessChanges(reader, allFiles) };
  const notes = { sceneIds: ["n"], name: "Notes", changes: sceneAccessChanges(reader, [reader, writer]) };
  const clock = { sceneIds: ["c"], name: "Clock", changes: sceneAccessChanges(reader, reader) };

  it("says what the clicked scene gains, in red when it reaches past the assets folder", () => {
    expect(sceneUpdateAccessNotice("p2", [photos], false)).toEqual({
      message: "New permissions in this version: reads all files (was the assets folder only).",
      danger: true,
    });
  });

  it("adds what updating all scenes gains for the others", () => {
    expect(sceneUpdateAccessNotice("p1", [photos, notes, clock], true)).toEqual({
      message:
        "New permissions in this version: reads all files (was the assets folder only).\n\n" +
        'Updating all scenes also adds new permissions: "Notes" writes files.',
      danger: true,
    });
  });

  it("keeps the button plain when only the other scenes gain something", () => {
    expect(sceneUpdateAccessNotice("c", [photos, notes, clock], true)).toEqual({
      message:
        'Updating all scenes also adds new permissions: "Photos" reads all files (was the assets folder only); ' +
        '"Notes" writes files.',
      danger: false,
    });
  });

  it("says nothing when nothing is gained, or when the others are not offered", () => {
    expect(sceneUpdateAccessNotice("c", [clock], true)).toEqual({ message: "", danger: false });
    expect(sceneUpdateAccessNotice("c", [photos, clock], false)).toEqual({ message: "", danger: false });
    expect(sceneUpdateAccessNotice("missing", [], true)).toEqual({ message: "", danger: false });
  });
});

describe("repo sample scenes", () => {
  // The two SD-card samples run the built-in Local Image app, which reads
  // any folder on the frame.
  it.each([
    ["repo/scenes/samples/SD card image/scenes.json", ["files"]],
    ["repo/scenes/samples/Ken Burns slideshow/scenes.json", ["files"]],
    // Files reads the assets folder and makes folders in it.
    ["repo/scenes/samples/Files/scenes.json", ["assets", "assets-write"]],
    // Books reads the EPUBs on the card, and writes the books it downloads
    // and the notes it exports into it.
    ["repo/scenes/samples/Books/scenes.json", ["assets", "assets-write"]],
    // Book highlights reads the highlights the reader keeps there, and writes nothing.
    ["repo/scenes/samples/Book highlights/scenes.json", ["assets"]],
    // The PDF viewer reads the PDFs on the card, and writes nothing there either.
    ["repo/scenes/samples/PDF viewer/scenes.json", ["assets"]],
    // Fonts lists the fonts folder and writes the fonts it gets into it.
    ["repo/scenes/samples/Fonts/scenes.json", ["assets", "assets-write"]],
    // The Scene store installs, updates and removes the frame's scenes.
    ["repo/scenes/samples/Scene store/scenes.json", ["store"]],
  ])("%s", (path, flags) => {
    expect(sceneAccessFlags(JSON.parse(repoFile(path)))).toEqual(flags);
  });
});

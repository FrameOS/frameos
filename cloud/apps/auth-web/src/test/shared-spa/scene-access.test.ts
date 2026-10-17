// What a scene reaches for on the frame (frontend/src/utils/sceneAccess.ts):
// the access it declares in settings.assetAccess, what its content uses, the
// flags the SPA and the store show, and what an update changes in them.
// docs/scene-access-fixtures.json is the corpus; the store's publish-time
// risk_flags call the same function.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  accessChangesAreRisky,
  describeGainedAccess,
  knownSceneAccessFlags,
  localImagePathReach,
  sceneAccess,
  sceneAccessChanges,
  sceneAccessFlagChanges,
  sceneAccessFlags,
} from "../../../../../../frontend/src/utils/sceneAccess";
import { sceneUpdateAccessNotice } from "../../../../../../frontend/src/utils/sceneUpdateAccess";
import { detectRiskFlags } from "../../lib/store";

const repoFile = (path: string): string =>
  readFileSync(new URL(`../../../../../../${path}`, import.meta.url), "utf8");

interface SceneCase {
  name: string;
  scene: unknown;
  expect: { declared: string; detected: string; effective: string; flags: string[]; writes: boolean };
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

const corpus = JSON.parse(repoFile("docs/scene-access-fixtures.json")) as {
  scenes: SceneCase[];
  sets: SetCase[];
  changes: ChangeCase[];
};

describe("sceneAccess corpus", () => {
  for (const fixture of corpus.scenes) {
    it(fixture.name, () => {
      const access = sceneAccess(fixture.scene);
      expect({
        declared: access.declared,
        detected: access.detected,
        effective: access.effective,
        flags: sceneAccessFlags([fixture.scene]),
        writes: access.writes,
      }).toEqual(fixture.expect);
      // The store's risk flags are the same answer.
      expect(detectRiskFlags([fixture.scene])).toEqual(fixture.expect.flags);
    });
  }
  for (const fixture of corpus.sets) {
    it(fixture.name, () => {
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
});

describe("sceneAccess details", () => {
  it("says why it flagged a scene", () => {
    const access = sceneAccess({
      nodes: [
        { id: "l", type: "app", data: { keyword: "data/localImage", config: { path: "/mnt/usb" } } },
        { id: "c", type: "code", data: { codeJS: "frameos.loadAssetImage('a.png'); frameos.writeAsset('b.png', x)" } },
      ],
    });
    expect(access.reasons).toEqual([
      "a Local Image node reads /mnt/usb, outside the assets folder",
      "its code calls frameos.loadAssetImage",
      "its code calls frameos.writeAsset",
    ]);
  });

  it("names a stream opened to write", () => {
    expect(sceneAccess({ nodes: [{ id: "c", type: "code", data: { codeJS: 'frameos.openAssetStream(p, "w")' } }] }).reasons).toEqual([
      "its code calls frameos.openAssetStream to write",
    ]);
  });

  it("checks a Local Image path against a frame's own assets folder", () => {
    expect(localImagePathReach("/data/assets/photos", "/data/assets/")).toBe("assets");
    expect(localImagePathReach("/srv/assets/photos", "/data/assets")).toBe("files");
  });

  it("orders catalog flags and drops the ones it does not know", () => {
    expect(knownSceneAccessFlags(["assets-write", "assets", "nsfw", "shell", "files"])).toEqual([
      "shell",
      "files",
      "assets-write",
    ]);
    expect(knownSceneAccessFlags(undefined)).toEqual([]);
  });
});

describe("what an update changes", () => {
  const reader = { id: "a", nodes: [{ id: "c", type: "code", data: { codeJS: "frameos.readAsset('x')" } }] };
  const allFiles = {
    id: "a",
    nodes: [{ id: "l", type: "app", data: { keyword: "data/localImage", config: { path: "/mnt/usb" } } }],
  };
  const writer = { id: "b", nodes: [{ id: "c", type: "code", data: { codeJS: "frameos.writeAsset('x', y)" } }] };

  it("reads a scene and its new version with the same detector", () => {
    const changes = sceneAccessChanges(reader, allFiles);
    expect(changes.gained).toEqual(["files"]);
    expect(describeGainedAccess(changes)).toBe("reads all files (was reads assets folder)");
    expect(accessChangesAreRisky(changes)).toBe(true);
  });

  it("compares sets of scenes as a whole", () => {
    const changes = sceneAccessChanges([reader], [reader, writer]);
    expect(changes.gained).toEqual(["assets-write"]);
    expect(describeGainedAccess(changes)).toBe("writes assets folder");
  });

  it("gaining only a read of the assets folder is not a red button", () => {
    const changes = sceneAccessChanges({ id: "a", nodes: [] }, reader);
    expect(describeGainedAccess(changes)).toBe("reads assets folder");
    expect(accessChangesAreRisky(changes)).toBe(false);
  });

  const photos = { sceneIds: ["p1", "p2"], name: "Photos", changes: sceneAccessChanges(reader, allFiles) };
  const notes = { sceneIds: ["n"], name: "Notes", changes: sceneAccessChanges(reader, [reader, writer]) };
  const clock = { sceneIds: ["c"], name: "Clock", changes: sceneAccessChanges(reader, reader) };

  it("says what the clicked scene gains, in red when it reaches past the assets folder", () => {
    expect(sceneUpdateAccessNotice("p2", [photos], false)).toEqual({
      message: "New permissions in this version: reads all files (was reads assets folder).",
      danger: true,
    });
  });

  it("adds what updating all scenes gains for the others", () => {
    expect(sceneUpdateAccessNotice("p1", [photos, notes, clock], true)).toEqual({
      message:
        "New permissions in this version: reads all files (was reads assets folder).\n\n" +
        'Updating all scenes also adds new permissions: "Notes" writes assets folder.',
      danger: true,
    });
  });

  it("keeps the button plain when only the other scenes gain something", () => {
    expect(sceneUpdateAccessNotice("c", [photos, notes, clock], true)).toEqual({
      message:
        'Updating all scenes also adds new permissions: "Photos" reads all files (was reads assets folder); ' +
        '"Notes" writes assets folder.',
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
  // The two SD-card samples point Local Image at a public state field, which
  // whoever controls the frame can set to any folder.
  it.each([
    ["repo/scenes/samples/SD card image/scenes.json", ["files"]],
    ["repo/scenes/samples/Ken Burns slideshow/scenes.json", ["files"]],
  ])("%s", (path, flags) => {
    expect(sceneAccessFlags(JSON.parse(repoFile(path)))).toEqual(flags);
  });
});

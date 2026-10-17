// What a scene reaches for on the frame (frontend/src/utils/sceneAccess.ts):
// the access it declares in settings.assetAccess, what its content uses, and
// the flags the SPA and the store show. docs/scene-access-fixtures.json is
// the corpus; the store's publish-time risk_flags call the same function.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  knownSceneAccessFlags,
  localImagePathReach,
  sceneAccess,
  sceneAccessFlags,
} from "../../../../../../frontend/src/utils/sceneAccess";
import { detectRiskFlags } from "../../lib/store";

const repoFile = (path: string): string =>
  readFileSync(new URL(`../../../../../../${path}`, import.meta.url), "utf8");

interface SceneCase {
  name: string;
  scene: unknown;
  expect: { declared: string; detected: string; effective: string; flags: string[] };
}
interface SetCase {
  name: string;
  scenes: unknown;
  flags: string[];
}

const corpus = JSON.parse(repoFile("docs/scene-access-fixtures.json")) as {
  scenes: SceneCase[];
  sets: SetCase[];
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
});

describe("sceneAccess details", () => {
  it("says why it flagged a scene", () => {
    const access = sceneAccess({
      nodes: [
        { id: "l", type: "app", data: { keyword: "data/localImage", config: { path: "/mnt/usb" } } },
        { id: "c", type: "code", data: { codeJS: "frameos.loadAssetImage('a.png')" } },
      ],
    });
    expect(access.reasons).toEqual([
      "a Local Image node reads /mnt/usb, outside the assets folder",
      "its code calls frameos.loadAssetImage",
    ]);
  });

  it("checks a Local Image path against a frame's own assets folder", () => {
    expect(localImagePathReach("/data/assets/photos", "/data/assets/")).toBe("assets");
    expect(localImagePathReach("/srv/assets/photos", "/data/assets")).toBe("files");
  });

  it("orders catalog flags and drops the ones it does not know", () => {
    expect(knownSceneAccessFlags(["assets", "nsfw", "shell", "files"])).toEqual(["shell", "files"]);
    expect(knownSceneAccessFlags(undefined)).toEqual([]);
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

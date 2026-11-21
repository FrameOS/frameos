import { strToU8, unzipSync, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  rebuildZipWithSceneOrigins,
  storeSceneHref,
  withStoreSceneOrigin,
} from "./scene-origin";

const source = {
  id: "0f3d1c2a-1111-4222-8333-444455556666",
  slug: "visited-world-map",
  version: 4,
};

describe("scene origin stamps", () => {
  let previousScenesUrl: string | undefined;
  beforeEach(() => {
    previousScenesUrl = process.env.FRAMEOS_SCENES_APP_URL;
    process.env.FRAMEOS_SCENES_APP_URL = "https://scenes.frameos.net";
  });
  afterEach(() => {
    if (previousScenesUrl === undefined) {
      delete process.env.FRAMEOS_SCENES_APP_URL;
    } else {
      process.env.FRAMEOS_SCENES_APP_URL = previousScenesUrl;
    }
  });

  it("names the scene's public page", () => {
    expect(storeSceneHref("visited-world-map")).toBe(
      "https://scenes.frameos.net/s/visited-world-map",
    );
  });

  it("stamps every scene with href, uuid, version and its own id", () => {
    const stamped = withStoreSceneOrigin(
      [
        { id: "visited-world-map", name: "Visited World Map", nodes: [] },
        { id: "second", name: "Second" },
      ],
      source,
    );
    expect(stamped).toEqual([
      {
        id: "visited-world-map",
        name: "Visited World Map",
        nodes: [],
        origin: {
          href: "https://scenes.frameos.net/s/visited-world-map",
          sceneId: "visited-world-map",
          storeSceneId: source.id,
          version: "4",
        },
      },
      {
        id: "second",
        name: "Second",
        origin: {
          href: "https://scenes.frameos.net/s/visited-world-map",
          sceneId: "second",
          storeSceneId: source.id,
          version: "4",
        },
      },
    ]);
  });

  it("replaces whatever origin the published copy carried", () => {
    // A publisher's workspace copy carries ITS install bookkeeping (an older
    // version of this very scene, or the scene it was forked from). That
    // must not ship on to installers as if it described this version.
    const [stamped] = withStoreSceneOrigin(
      [
        {
          id: "a",
          origin: {
            href: "https://scenes.frameos.net/s/some-other-scene",
            repositoryUrl: "https://example.com/repo.json",
            storeSceneId: "ffffffff-0000-4000-8000-000000000000",
            version: "1",
          },
        },
      ],
      source,
    );
    expect((stamped as { origin: unknown }).origin).toEqual({
      href: "https://scenes.frameos.net/s/visited-world-map",
      sceneId: "a",
      storeSceneId: source.id,
      version: "4",
    });
  });

  it("leaves non-object entries alone and skips sceneId for id-less scenes", () => {
    const stamped = withStoreSceneOrigin([null, "x", { name: "no id" }], source);
    expect(stamped[0]).toBeNull();
    expect(stamped[1]).toBe("x");
    expect((stamped[2] as unknown as { origin: { sceneId?: string } }).origin.sceneId).toBeUndefined();
  });

  it("stamps every scene and lays the zip out as scene packages, the manifest and image kept", () => {
    const manifest = strToU8(JSON.stringify({ name: "Visited World Map" }, null, 2));
    const image = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    const zip = Buffer.from(
      zipSync({
        "Visited World Map/template.json": manifest,
        "Visited World Map/scenes.json": strToU8(
          JSON.stringify([
            {
              id: "visited-world-map",
              name: "Visited World Map",
              nodes: [],
              edges: [],
              apps: { map: { name: "Map", sources: { "app.ts": "export const a = 1\n" } } },
            },
          ]),
        ),
        "Visited World Map/image.jpg": image,
        "Visited World Map/README.md": strToU8("dropped, like the other rebuilds"),
      }),
    );
    const origin = {
      href: "https://scenes.frameos.net/s/visited-world-map",
      sceneId: "visited-world-map",
      storeSceneId: source.id,
      version: "4",
    };
    const rebuilt = rebuildZipWithSceneOrigins(zip, source);
    expect(rebuilt).toBeDefined();
    const files = unzipSync(new Uint8Array(rebuilt!));
    // The app's files under its folder (config.json is the origin stamp's
    // permissions, withAppPermissions).
    expect(Object.keys(files).sort()).toEqual([
      "Visited World Map/Visited World Map/apps/map/app.ts",
      "Visited World Map/Visited World Map/apps/map/config.json",
      "Visited World Map/Visited World Map/scene.json",
      "Visited World Map/image.jpg",
      "Visited World Map/template.json",
    ]);
    expect(JSON.parse(Buffer.from(files["Visited World Map/template.json"]!).toString("utf8"))).toEqual({
      name: "Visited World Map",
      scenes: ["./Visited World Map"],
    });
    expect(Buffer.from(files["Visited World Map/image.jpg"]!)).toEqual(Buffer.from(image));
    const scene = JSON.parse(Buffer.from(files["Visited World Map/Visited World Map/scene.json"]!).toString("utf8"));
    expect(scene).toMatchObject({ edges: [], id: "visited-world-map", name: "Visited World Map", nodes: [], origin });
    expect(scene.apps.map.sources).toBeUndefined();

    // ?layout=json: the form before packages, for a backend that reads only that.
    const legacy = unzipSync(new Uint8Array(rebuildZipWithSceneOrigins(zip, source, "json")!));
    expect(Object.keys(legacy).sort()).toEqual([
      "Visited World Map/image.jpg",
      "Visited World Map/scenes.json",
      "Visited World Map/template.json",
    ]);
    const scenes = JSON.parse(Buffer.from(legacy["Visited World Map/scenes.json"]!).toString("utf8"));
    expect(scenes[0].origin).toEqual(origin);
    expect(scenes[0].apps.map.sources["app.ts"]).toBe("export const a = 1\n");
  });

  it("refuses zips without a manifest or scenes.json", () => {
    const noScenes = Buffer.from(zipSync({ "x/template.json": strToU8("{}") }));
    expect(rebuildZipWithSceneOrigins(noScenes, source)).toBeUndefined();
    const noManifest = Buffer.from(zipSync({ "x/scenes.json": strToU8("[]") }));
    expect(rebuildZipWithSceneOrigins(noManifest, source)).toBeUndefined();
    expect(rebuildZipWithSceneOrigins(Buffer.from("not a zip"), source)).toBeUndefined();
  });
});

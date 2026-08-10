import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
  extractScenesFromZip,
  sceneDisplayName,
} from "./scene-title";
import { rebuildZipWithScenes, validateSceneZip } from "./store";

function makeZip(
  manifest: Record<string, unknown>,
  scenes: unknown[],
  folder = "Ken Burns Slideshow/",
): Buffer {
  return Buffer.from(
    zipSync({
      [`${folder}template.json`]: strToU8(JSON.stringify(manifest, null, 2)),
      [`${folder}scenes.json`]: strToU8(JSON.stringify(scenes, null, 2)),
    }),
  );
}

describe("sceneDisplayName", () => {
  it("uses the default scene, else the first one", () => {
    expect(sceneDisplayName([{ id: "a", name: "Only" }])).toBe("Only");
    expect(
      sceneDisplayName([
        { id: "a", name: "First" },
        { id: "b", name: "Default", default: true },
      ]),
    ).toBe("Default");
  });

  it("trims, truncates and rejects empty or unusable input", () => {
    expect(sceneDisplayName([{ name: "  Padded  " }])).toBe("Padded");
    expect(sceneDisplayName([{ name: "x".repeat(200) }])).toHaveLength(128);
    expect(sceneDisplayName([{ name: "   " }])).toBeUndefined();
    expect(sceneDisplayName([{ id: "a" }])).toBeUndefined();
    expect(sceneDisplayName([])).toBeUndefined();
    expect(sceneDisplayName(null)).toBeUndefined();
    expect(sceneDisplayName("not scenes")).toBeUndefined();
  });
});

describe("extractScenesFromZip", () => {
  it("reads the shallowest scenes.json", () => {
    const zip = makeZip({ name: "XKCD" }, [{ id: "a", name: "XKCD" }]);
    expect(sceneDisplayName(extractScenesFromZip(zip))).toBe("XKCD");
  });

  it("returns undefined for junk instead of throwing", () => {
    expect(extractScenesFromZip(Buffer.from("not a zip"))).toBeUndefined();
    expect(
      extractScenesFromZip(
        Buffer.from(
          zipSync({ "s/scenes.json": strToU8("{\"not\": \"an array\"}") }),
        ),
      ),
    ).toBeUndefined();
  });
});

// The bug: renaming a scene in the editor rewrote scenes.json but left
// template.json — the manifest publishing reads storeScenes.name from — on the
// old title, so the store page's <h1> never changed. The content route now
// detects the rename and passes it through as `renameTo`.
describe("editor rename reaching the listing title", () => {
  const scenes = [{ id: "a", name: "Ken Burns Slideshow" }];
  const zip = makeZip(
    { name: "Ken Burns Slideshow", description: "Pan and zoom" },
    scenes,
  );

  it("detects the rename by comparing the stored scenes with the edited ones", () => {
    const edited = [{ id: "a", name: "Ken Burns Deluxe" }];
    expect(sceneDisplayName(extractScenesFromZip(zip))).toBe(
      "Ken Burns Slideshow",
    );
    expect(sceneDisplayName(edited)).toBe("Ken Burns Deluxe");
  });

  it("carries the new title into template.json, so the listing follows", () => {
    const edited = [{ id: "a", name: "Ken Burns Deluxe" }];
    const rebuilt = rebuildZipWithScenes(
      zip,
      JSON.stringify(edited, null, 2),
      sceneDisplayName(edited),
    );
    expect(rebuilt).toBeDefined();
    const validated = validateSceneZip(rebuilt!);
    expect(validated.ok).toBe(true);
    if (!validated.ok) {
      return;
    }
    expect(validated.value.manifestName).toBe("Ken Burns Deluxe");
    // Everything else about the listing survives the rename.
    expect(validated.value.manifestDescription).toBe("Pan and zoom");
    expect(sceneDisplayName(extractScenesFromZip(rebuilt!))).toBe(
      "Ken Burns Deluxe",
    );
  });

  it("leaves the manifest byte-identical when nothing was renamed", () => {
    const editedSameName = [
      { id: "a", name: "Ken Burns Slideshow", nodes: [{ id: "n1" }] },
    ];
    const rebuilt = rebuildZipWithScenes(
      zip,
      JSON.stringify(editedSameName, null, 2),
      undefined,
    );
    expect(rebuilt).toBeDefined();
    const validated = validateSceneZip(rebuilt!);
    expect(validated.ok && validated.value.manifestName).toBe(
      "Ken Burns Slideshow",
    );
  });
});

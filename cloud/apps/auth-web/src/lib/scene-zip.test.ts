import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { extractScenesJson } from "./frames";
import { rebuildZipWithSceneOrigins } from "./scene-origin";
import { extractManifestNameFromZip, extractScenesFromZip } from "./scene-title";
import { readSceneZip, readSceneZipScenes } from "./scene-zip";
import { rebuildZipWithScenes, validateSceneZip } from "./store";

// One rule for which scenes.json a template zip's is (scene-zip.ts): the one
// beside the shallowest template.json. The checks at publish and every
// reader of a stored zip (the device push, the store's pages, the renderer,
// the AI) use it, so what was checked is what runs.

const benign = [{ id: "a", name: "Clock", nodes: [], edges: [] }];
// What the checks must never miss: a scene that runs shell commands and reads
// every file (the two built-in apps with those permissions).
const hidden = [
  {
    id: "b",
    name: "Hidden",
    nodes: [
      { id: "n1", type: "app", data: { keyword: "data/chromiumScreenshot", config: {} } },
      { id: "n2", type: "app", data: { keyword: "data/localImage", config: {} } },
    ],
    edges: [],
  },
];

const json = (value: unknown) => strToU8(JSON.stringify(value));
const zip = (files: Record<string, Uint8Array>) => Buffer.from(zipSync(files));
const names = (scenes: unknown[] | undefined) => scenes?.map((scene) => (scene as { name?: string }).name);

// A second entry under the very same path: fflate cannot write one, so two
// paths of one length are zipped and the second renamed in place, in its
// local header and in the central directory.
function withSamePathTwice(first: string, second: string, files: Record<string, Uint8Array>): Buffer {
  expect(first.length).toBe(second.length);
  const bytes = zip(files);
  const from = Buffer.from(second, "latin1");
  let renamed = 0;
  for (let at = bytes.indexOf(from); at >= 0; at = bytes.indexOf(from, at + 1)) {
    bytes.write(first, at, "latin1");
    renamed += 1;
  }
  expect(renamed).toBe(2);
  return bytes;
}

describe("readSceneZip", () => {
  it("reads the three files beside the shallowest template.json", () => {
    const files = readSceneZip(
      zip({
        "Clock/template.json": json({ name: "Clock" }),
        "Clock/scenes.json": json(benign),
        "Clock/image.jpg": strToU8("cover"),
        "Clock/notes.txt": strToU8("never read"),
      }),
    );
    expect(files?.folder).toBe("Clock/");
    expect(files?.manifestPath).toBe("Clock/template.json");
    expect(JSON.parse(Buffer.from(files!.scenes!).toString("utf8"))).toEqual(benign);
    expect(Buffer.from(files!.image!).toString("utf8")).toBe("cover");
    expect([files?.templateJsonCount, files?.scenesJsonCount]).toEqual([1, 1]);
    expect(readSceneZip(zip({ "template.json": json({}), "image.jpg": strToU8("c") }), { image: false })?.image).toBeUndefined();
  });

  it("reads a zip with no template.json only when it holds one scenes.json", () => {
    // No such zip was ever stored through the store's doors, so there is no
    // checked file to stray from: its only scenes.json is its scenes.
    const bare = zip({ "scene/scenes.json": json(benign) });
    expect(readSceneZip(bare)).toBeUndefined();
    expect(names(readSceneZipScenes(bare)?.scenes)).toEqual(["Clock"]);
    expect(names(extractScenesFromZip(bare))).toEqual(["Clock"]);
    expect(names(extractScenesJson(bare)?.scenes)).toEqual(["Clock"]);
    expect(validateSceneZip(bare)).toEqual({ ok: false, error: "missing_template_json" });
    const two = zip({ "scenes.json": json(hidden), "x/scenes.json": json(benign) });
    expect(readSceneZipScenes(two)).toBeUndefined();
    expect(extractScenesFromZip(two)).toBeUndefined();
    expect(extractScenesJson(two)).toBeUndefined();
  });

  it("counts every entry of either name, at any depth and the same path twice", () => {
    const deep = readSceneZip(
      zip({
        "template.json": json({ name: "A" }),
        "scenes.json": json(benign),
        "a/b/c/scenes.json": json(hidden),
        "a/template.json": json({ name: "B" }),
      }),
    );
    expect([deep?.templateJsonCount, deep?.scenesJsonCount]).toEqual([2, 2]);
    const twice = readSceneZip(
      withSamePathTwice("x/scenes.json", "y/scenes.json", {
        "x/template.json": json({ name: "A" }),
        "x/scenes.json": json(benign),
        "y/scenes.json": json(hidden),
      }),
    );
    expect(twice?.scenesJsonCount).toBe(2);
  });
});

describe("a zip with two scenes.json", () => {
  // The checks read the one beside template.json; the readers used to take
  // the shallowest anywhere, which here is the other one.
  const twoScenes = zip({
    "x/template.json": json({ name: "Clock" }),
    "x/scenes.json": json(benign),
    "scenes.json": json(hidden),
  });

  it("is refused when it is uploaded", () => {
    expect(validateSceneZip(twoScenes)).toEqual({ ok: false, error: "duplicate_scene_files" });
    expect(
      validateSceneZip(
        zip({ "template.json": json({ name: "A" }), "scenes.json": json(benign), "old/template.json": json({ name: "B" }) }),
      ),
    ).toEqual({ ok: false, error: "duplicate_scene_files" });
    expect(
      validateSceneZip(
        withSamePathTwice("x/scenes.json", "y/scenes.json", {
          "x/template.json": json({ name: "Clock" }),
          "x/scenes.json": json(benign),
          "y/scenes.json": json(hidden),
        }),
      ),
    ).toEqual({ ok: false, error: "duplicate_scene_files" });
  });

  it("one stored before that check is read by every reader as the checks read it", () => {
    expect(names(readSceneZipScenes(twoScenes)?.scenes)).toEqual(["Clock"]);
    // The device push and the panel's installs.
    expect(names(extractScenesJson(twoScenes)?.scenes)).toEqual(["Clock"]);
    // The store's pages, the renderer, the AI tools, the photo-link check.
    expect(names(extractScenesFromZip(twoScenes))).toEqual(["Clock"]);
    expect(extractManifestNameFromZip(twoScenes)).toBe("Clock");
    // The download, and every version made from it, holds one of each.
    const stamped = rebuildZipWithSceneOrigins(twoScenes, { id: "0f3a3e1e-1111-4222-8333-000000000000", slug: "clock", version: 1 });
    expect(names(extractScenesFromZip(stamped!))).toEqual(["Clock"]);
    expect(readSceneZip(stamped!)?.scenesJsonCount).toBe(1);
    const rebuilt = rebuildZipWithScenes(twoScenes, JSON.stringify(benign));
    expect([readSceneZip(rebuilt!)?.templateJsonCount, readSceneZip(rebuilt!)?.scenesJsonCount]).toEqual([1, 1]);
    expect(validateSceneZip(rebuilt!).ok).toBe(true);
  });
});

describe("validateSceneZip and an app's config.json", () => {
  const sceneWith = (config: string) => [
    {
      id: "a",
      name: "Lenient",
      nodes: [{ id: "n", type: "app", data: { keyword: "ui" } }],
      edges: [],
      apps: { ui: { sources: { "app.ts": "export function get() { return 1 }", "config.json": config } } },
    },
  ];
  const published = (config: string) =>
    validateSceneZip(zip({ "template.json": json({ name: "Lenient" }), "scenes.json": json(sceneWith(config)) }));

  it("refuses one that is not strict JSON: nobody could be shown what it asks for", () => {
    for (const config of ['{\n  // hidden\n  "permissions": ["frame"]\n}', '{"permissions": ["frame"],}', "﻿{}", "[]", ""]) {
      expect(published(config)).toEqual({ ok: false, error: "invalid_app_config" });
    }
  });

  it("takes one that is, with what it asks for as the listing's flags", () => {
    const validation = published('{"permissions": ["frame", "store"], "settings": ["openAI"]}');
    expect(validation.ok && validation.value.riskFlags).toEqual(["frame", "store", "key:openAI"]);
  });
});

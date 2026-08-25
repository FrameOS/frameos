import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import type { FrameScene } from "../../../../../../frontend/src/types";
import {
  SceneUploadError,
  parseSceneUpload,
  sceneNeedsAutoArrange,
} from "../../../../../../frontend/src/utils/sceneUpload";

// The "Upload scene" option in the frame's Add scene drawer parses the file
// in the browser (no /api/templates round-trip, so it works on the cloud
// control plane too) and hands the scenes to frameLogic.applyTemplate. These
// are the pure pieces of that path.

// Nodes deliberately carry no position: that is how exported templates and
// hand-written scene files usually arrive, and sanitizeScene fills it in.
const scene = (id: string, name: string): Partial<FrameScene> =>
  ({
    id,
    name,
    nodes: [{ id: `${id}-n1`, type: "event", data: { keyword: "render" } }],
    edges: [],
  }) as unknown as Partial<FrameScene>;

describe("parseSceneUpload", () => {
  it("reads name and scenes from a template zip", () => {
    const zip = zipSync({
      "Clock/template.json": strToU8(
        JSON.stringify({ name: "  Clock  ", description: "Tells the time" }),
      ),
      "Clock/scenes.json": strToU8(JSON.stringify([scene("s1", "Clock")])),
      "Clock/image.jpg": new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
    });

    const parsed = parseSceneUpload(zip, "clock.zip");
    expect(parsed.name).toBe("Clock");
    expect(parsed.description).toBe("Tells the time");
    expect(parsed.scenes.map((s) => s.id)).toEqual(["s1"]);
  });

  it("uses the shallowest template.json and its sibling scenes.json", () => {
    const zip = zipSync({
      "template.json": strToU8(JSON.stringify({ name: "Outer" })),
      "scenes.json": strToU8(JSON.stringify([scene("outer", "Outer")])),
      "nested/template.json": strToU8(JSON.stringify({ name: "Inner" })),
      "nested/scenes.json": strToU8(JSON.stringify([scene("inner", "Inner")])),
    });

    const parsed = parseSceneUpload(zip, "bundle.zip");
    expect(parsed.name).toBe("Outer");
    expect(parsed.scenes.map((s) => s.id)).toEqual(["outer"]);
  });

  it("accepts a zip with only a scenes.json", () => {
    const zip = zipSync({
      "scenes.json": strToU8(JSON.stringify([scene("s1", "Bare")])),
    });
    const parsed = parseSceneUpload(zip, "bare.zip");
    expect(parsed.name).toBeUndefined();
    expect(parsed.scenes).toHaveLength(1);
  });

  it("rejects a zip whose template.json has no scenes.json beside it", () => {
    const zip = zipSync({
      "template.json": strToU8(JSON.stringify({ name: "Lonely" })),
      "other/scenes.json": strToU8(JSON.stringify([scene("s1", "Elsewhere")])),
    });
    expect(() => parseSceneUpload(zip, "lonely.zip")).toThrow(SceneUploadError);
    expect(() => parseSceneUpload(zip, "lonely.zip")).toThrow(/no scenes\.json next to it/);
  });

  it("accepts a bare scenes array", () => {
    const bytes = strToU8(JSON.stringify([scene("a", "A"), scene("b", "B")]));
    const parsed = parseSceneUpload(bytes, "scenes.json");
    expect(parsed.name).toBeUndefined();
    expect(parsed.scenes.map((s) => s.name)).toEqual(["A", "B"]);
  });

  it("accepts a single scene object", () => {
    const bytes = strToU8(JSON.stringify(scene("solo", "Solo")));
    const parsed = parseSceneUpload(bytes, "Solo.JSON");
    expect(parsed.scenes).toHaveLength(1);
    expect(parsed.scenes[0]?.id).toBe("solo");
  });

  it("rejects JSON that is not a scene", () => {
    expect(() => parseSceneUpload(strToU8(JSON.stringify({ name: "no nodes" })), "x.json")).toThrow(
      /must be a scene/,
    );
    expect(() => parseSceneUpload(strToU8("[]"), "x.json")).toThrow(/contains no scenes/);
    expect(() =>
      parseSceneUpload(strToU8(JSON.stringify([scene("ok", "ok"), { nodes: [] }])), "x.json"),
    ).toThrow(/each with nodes and edges/);
  });

  it("rejects a file that is neither a zip nor JSON", () => {
    const junk = strToU8("hello there");
    expect(() => parseSceneUpload(junk, "notes.txt")).toThrow(SceneUploadError);
    expect(() => parseSceneUpload(junk, "broken.zip")).toThrow(/not a readable template \.zip/);
    expect(() => parseSceneUpload(junk, "broken.json")).toThrow(/not valid JSON/);
  });

  it("sniffs a zip signature when the extension is unknown", () => {
    const zip = zipSync({
      "scenes.json": strToU8(JSON.stringify([scene("s1", "Sniffed")])),
    });
    expect(parseSceneUpload(zip, "download")).toEqual({
      scenes: [scene("s1", "Sniffed")],
    });
  });
});

describe("sceneNeedsAutoArrange", () => {
  it("is true only when some node lacks a finite position", () => {
    expect(sceneNeedsAutoArrange(scene("s", "s"))).toBe(true);
    expect(
      sceneNeedsAutoArrange({
        nodes: [{ id: "n", position: { x: 10, y: 20 } } as never],
        edges: [],
      }),
    ).toBe(false);
    expect(sceneNeedsAutoArrange({ nodes: [], edges: [] })).toBe(false);
  });
});

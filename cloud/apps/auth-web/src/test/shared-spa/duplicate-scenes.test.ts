// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { remapSceneIds } from "../../../../../../frontend/src/utils/duplicateScenes";

// The editor has no test runner of its own (frontend/); its pure helpers are
// pinned from here. Two 2026-09 review findings, each a one-line bug:
// remapSceneIds wrote the rewritten config.json to a top-level `sources`
// (ignored by every reader, saved as junk) and threw on any node type it did
// not know, aborting whole template installs inside a listener.

type AnyNode = { id: string; type: string; data: Record<string, unknown> } & Record<string, unknown>;
type AnyScene = { id: string; nodes: AnyNode[] };

function scene(nodes: AnyNode[]) {
  return { id: "scene-a", name: "A", nodes, edges: [], fields: [], customEvents: [] };
}

function remap(scenes: unknown[]): AnyScene[] {
  return remapSceneIds(scenes as never, (id: string) => `${id}-copy`) as unknown as AnyScene[];
}

describe("remapSceneIds", () => {
  it("rewrites a source node's scene-typed config under data.sources", () => {
    const configJson = JSON.stringify({ fields: [{ name: "target", type: "scene", value: "scene-a" }] });
    const [out] = remap([
      scene([{ id: "n1", type: "source", data: { config: { target: "scene-a" }, sources: { "config.json": configJson } } }]),
    ]);
    const node = out!.nodes[0]!;
    const data = node.data as { config: Record<string, string>; sources: Record<string, string> };
    expect(data.config.target).toBe("scene-a-copy");
    expect(JSON.parse(data.sources["config.json"]!).fields[0].value).toBe("scene-a-copy");
    expect("sources" in node).toBe(false);
  });

  it("rewrites scene nodes, scene-typed fields and custom-event fields, and copies the edges", () => {
    const [out] = remapSceneIds(
      [
        {
          ...scene([
            { id: "n1", type: "scene", data: { keyword: "scene-b" } },
            { id: "n2", type: "code", data: { code: "return 1" } },
          ]),
          edges: [{ id: "e1", source: "n1", target: "n2" }],
          fields: [
            { name: "next", type: "scene", value: "scene-b" },
            { name: "title", type: "string", value: "scene-b" },
          ],
          customEvents: [{ name: "go", fields: [{ name: "to", type: "scene", value: "scene-a" }] }],
        },
      ] as never,
      (id: string) => `${id}-copy`,
    ) as unknown as Array<Record<string, any>>;
    expect(out!.id).toBe("scene-a-copy");
    expect(out!.nodes[0].data.keyword).toBe("scene-b-copy");
    // Code nodes carry no scene ids; untouched.
    expect(out!.nodes[1].data).toEqual({ code: "return 1" });
    expect(out!.edges).toEqual([{ id: "e1", source: "n1", target: "n2" }]);
    expect(out!.fields.map((f: { value: string }) => f.value)).toEqual(["scene-b-copy", "scene-b"]);
    expect(out!.customEvents[0].fields[0].value).toBe("scene-a-copy");
  });

  it("copies a node type it does not know instead of throwing", () => {
    const unknown: AnyNode = { id: "n2", type: "widget", data: { anything: 1 } };
    const [out] = remap([scene([unknown])]);
    expect(out!.id).toBe("scene-a-copy");
    expect(out!.nodes[0]).toEqual(unknown);
  });
});

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

  it("copies a node type it does not know instead of throwing", () => {
    const unknown: AnyNode = { id: "n2", type: "widget", data: { anything: 1 } };
    const [out] = remap([scene([unknown])]);
    expect(out!.id).toBe("scene-a-copy");
    expect(out!.nodes[0]).toEqual(unknown);
  });
});

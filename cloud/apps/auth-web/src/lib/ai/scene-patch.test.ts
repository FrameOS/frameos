import { describe, expect, it } from "vitest";
import { applyScenePatch, applySourceEdits, executeTool, workingScene, type ToolContext } from "./tools";
import type { JsonObject } from "./scene-utils";

// A small interpreted scene with one bundled app, in the shape the store's
// Weather scene has (apps map with sources, app nodes referencing keywords).
function scene(): JsonObject {
  return {
    apps: {
      panel: {
        name: "Panel",
        sources: {
          "app.ts": 'export function render() {\n  const glyph = "bespoke";\n  return glyph;\n}\n',
          "config.json": '{"name":"Panel","fields":[]}',
        },
      },
    },
    edges: [
      { id: "e1", source: "n1", sourceHandle: "next", target: "n2", targetHandle: "prev", type: "appNodeEdge" },
      { source: "n2", sourceHandle: "next", target: "n3", targetHandle: "prev", type: "appNodeEdge" },
    ],
    fields: [{ name: "city", type: "string", value: "Tallinn" }],
    id: "s1",
    name: "Weather",
    nodes: [
      { data: { keyword: "render" }, id: "n1", type: "event" },
      { data: { config: {}, keyword: "panel" }, id: "n2", type: "app" },
      { data: { codeJS: "return 1 + 1", codeOutputs: [{ name: "x", type: "integer" }] }, id: "n3", type: "code" },
    ],
    settings: { execution: "interpreted" },
  };
}

describe("applyScenePatch", () => {
  it("replaces a node by id, adds new ones and leaves the rest alone", () => {
    const base = scene();
    const { changes, issues, scene: out } = applyScenePatch(base, {
      set_nodes: [
        { data: { config: { theme: "dark" }, keyword: "panel" }, id: "n2", type: "app" },
        { data: { keyword: "render" }, id: "n4", type: "dispatch" },
      ],
    });
    expect(issues).toEqual([]);
    expect(changes).toEqual(["nodes: 1 replaced, 1 added"]);
    expect((out.nodes as JsonObject[]).map((node) => node.id)).toEqual(["n1", "n2", "n3", "n4"]);
    expect(((out.nodes as JsonObject[])[1]!.data as JsonObject).config).toEqual({ theme: "dark" });
    expect(out.apps).toEqual(base.apps);
    expect(out.edges).toEqual(base.edges);
    // The input is never mutated.
    expect(((base.nodes as JsonObject[])[1]!.data as JsonObject).config).toEqual({});
  });

  it("removes nodes together with their edges", () => {
    const { changes, issues, scene: out } = applyScenePatch(scene(), { remove_nodes: ["n3"] });
    expect(issues).toEqual([]);
    expect(changes).toEqual(["removed 1 node(s) and 1 attached edge(s)"]);
    expect((out.nodes as JsonObject[]).map((node) => node.id)).toEqual(["n1", "n2"]);
    expect(out.edges).toHaveLength(1);
  });

  it("matches edges without ids by endpoints when removing", () => {
    const { issues, scene: out } = applyScenePatch(scene(), {
      remove_edges: ["e1", { source: "n2", target: "n3" }],
      set_edges: [{ source: "n1", sourceHandle: "next", target: "n3", targetHandle: "prev", type: "appNodeEdge" }],
    });
    expect(issues).toEqual([]);
    expect(out.edges).toEqual([
      { source: "n1", sourceHandle: "next", target: "n3", targetHandle: "prev", type: "appNodeEdge" },
    ]);
  });

  it("replaces one app source file and keeps the others", () => {
    const { changes, issues, scene: out } = applyScenePatch(scene(), {
      apps: { panel: { sources: { "app.ts": "export function render() { return 'svg' }\n" } } },
    });
    expect(issues).toEqual([]);
    expect(changes).toEqual(["app panel sources: app.ts"]);
    const sources = ((out.apps as JsonObject).panel as JsonObject).sources as JsonObject;
    expect(sources["app.ts"]).toBe("export function render() { return 'svg' }\n");
    expect(sources["config.json"]).toBe('{"name":"Panel","fields":[]}');
    expect(((out.apps as JsonObject).panel as JsonObject).name).toBe("Panel");
  });

  it("removes files and apps with null, and adds new apps", () => {
    const { changes, issues, scene: out } = applyScenePatch(scene(), {
      apps: {
        icons: { sources: { "app.ts": "export const icons = {}" } },
        panel: { sources: { "config.json": null } },
      },
    });
    expect(issues).toEqual([]);
    expect(changes).toEqual(["app icons sources: +app.ts", "app panel sources: -config.json"]);
    expect(Object.keys(((out.apps as JsonObject).panel as JsonObject).sources as JsonObject)).toEqual(["app.ts"]);
    expect(Object.keys(out.apps as JsonObject).sort()).toEqual(["icons", "panel"]);
    const removed = applyScenePatch(scene(), { apps: { panel: null } });
    expect(removed.scene.apps).toEqual({});
  });

  it("refuses the whole patch on an unknown id, so typos never half-apply", () => {
    const { issues, changes } = applyScenePatch(scene(), {
      remove_nodes: ["nope"],
      set_nodes: [{ data: {}, id: "n9", type: "app" }],
    });
    expect(issues).toEqual(['remove_nodes: no node with id "nope".']);
    expect(changes).not.toContain(expect.stringContaining("removed"));
  });

  it("merges settings, replaces fields and renames", () => {
    const { changes, scene: out } = applyScenePatch(scene(), {
      fields: [],
      name: "Weather 2",
      settings: { refreshInterval: 300 },
    });
    expect(changes).toEqual(['renamed scene to "Weather 2"', "fields replaced (0)", "settings merged (refreshInterval)"]);
    expect(out.settings).toEqual({ execution: "interpreted", refreshInterval: 300 });
    expect(out.fields).toEqual([]);
  });
});

describe("applySourceEdits", () => {
  it("edits an app file with exact single-match find/replace", () => {
    const { issues, scene: out, summary } = applySourceEdits(scene(), {
      app: "panel",
      edits: [
        { find: 'const glyph = "bespoke";', replace: 'const glyph = "<text>";' },
        { find: "return glyph;", replace: "return `<text>${glyph}</text>`;" },
      ],
      file: "app.ts",
    });
    expect(issues).toEqual([]);
    expect(summary).toMatch(/^panel\/app.ts: 2 replacement\(s\)/);
    const source = (((out.apps as JsonObject).panel as JsonObject).sources as JsonObject)["app.ts"];
    expect(source).toContain('const glyph = "<text>";');
    expect(source).toContain("return `<text>${glyph}</text>`;");
  });

  it("refuses ambiguous and missing finds and changes nothing", () => {
    const base = scene();
    const ambiguous = applySourceEdits(base, {
      app: "panel",
      edits: [{ find: "glyph", replace: "g" }],
      file: "app.ts",
    });
    expect(ambiguous.issues[0]).toMatch(/matches 2 times in panel\/app.ts/);
    expect(ambiguous.scene).toEqual(base);
    const missing = applySourceEdits(base, {
      app: "panel",
      edits: [{ find: "nothing like this\nsecond line", replace: "" }],
      file: "app.ts",
    });
    expect(missing.issues[0]).toMatch(/not found in panel\/app.ts: "nothing like this" \(first line shown\)/);
    expect(missing.scene).toEqual(base);
  });

  it("replaces every occurrence with all: true", () => {
    const { issues, scene: out } = applySourceEdits(scene(), {
      app: "panel",
      edits: [{ all: true, find: "glyph", replace: "g" }],
      file: "app.ts",
    });
    expect(issues).toEqual([]);
    const source = (((out.apps as JsonObject).panel as JsonObject).sources as JsonObject)["app.ts"] as string;
    expect(source).not.toContain("glyph");
    expect(source.split("g;").length).toBeGreaterThan(1);
  });

  it("picks the only file when file is omitted and reports the options otherwise", () => {
    const withTwo = applySourceEdits(scene(), { app: "panel", edits: [{ find: "x", replace: "y" }] });
    expect(withTwo.issues[0]).toBe('Which file? App "panel" has: app.ts, config.json.');
    const single = scene();
    delete ((single.apps as JsonObject).panel as JsonObject).sources!["config.json" as never];
    const picked = applySourceEdits(single, { app: "panel", edits: [{ find: "bespoke", replace: "svg" }] });
    expect(picked.issues).toEqual([]);
    expect(picked.summary).toMatch(/^panel\/app.ts/);
    const unknown = applySourceEdits(scene(), { app: "nope", edits: [{ find: "x", replace: "y" }] });
    expect(unknown.issues[0]).toBe('No app "nope" in this scene\'s apps map (have: panel).');
  });

  it("edits a code node's snippet by node id", () => {
    const { issues, scene: out, summary } = applySourceEdits(scene(), {
      edits: [{ find: "1 + 1", replace: "2 * 2" }],
      node_id: "n3",
    });
    expect(issues).toEqual([]);
    expect(summary).toMatch(/^code node n3/);
    expect(((out.nodes as JsonObject[])[2]!.data as JsonObject).codeJS).toBe("return 2 * 2");
    const notCode = applySourceEdits(scene(), { edits: [{ find: "a", replace: "b" }], node_id: "n2" });
    expect(notCode.issues[0]).toMatch(/has no editable source/);
  });
});

describe("patch tools through executeTool", () => {
  function context(overrides: Partial<ToolContext> = {}): ToolContext & { delivered: unknown[][] } {
    const delivered: unknown[][] = [];
    return {
      accountId: "a1",
      currentScene: scene(),
      currentSceneId: "s1",
      db: {} as ToolContext["db"],
      delivered,
      emitScenes: (event) => delivered.push(event.scenes),
      prompt: "test",
      ...overrides,
    };
  }

  it("patch_scene delivers the merged scene and reports what it applied", async () => {
    const ctx = context();
    const output = JSON.parse(
      await executeTool(
        "patch_scene",
        { apps: { panel: { sources: { "app.ts": "export function render() { return 1 }" } } } },
        ctx,
      ),
    ) as JsonObject;
    expect(output.ok).toBe(true);
    expect(output.applied).toEqual(["app panel sources: app.ts"]);
    expect(ctx.delivered).toHaveLength(1);
    const scenes = ctx.delivered[0] as JsonObject[];
    expect(scenes[0]!.id).toBe("s1");
    expect((scenes[0]!.nodes as unknown[]).length).toBe(3);
    expect(ctx.deliveredTool).toBe("modify_scene");
  });

  it("a second partial edit in the same turn builds on the first", async () => {
    const ctx = context();
    await executeTool("patch_scene", { name: "Renamed" }, ctx);
    expect((workingScene(ctx) as JsonObject).name).toBe("Renamed");
    const output = JSON.parse(
      await executeTool(
        "edit_app_source",
        { app: "panel", edits: [{ find: '"bespoke"', replace: '"svg"' }], file: "app.ts" },
        ctx,
      ),
    ) as JsonObject;
    expect(output.ok).toBe(true);
    const latest = ctx.delivered[1] as JsonObject[];
    expect(latest[0]!.name).toBe("Renamed");
    expect((((latest[0]!.apps as JsonObject).panel as JsonObject).sources as JsonObject)["app.ts"]).toContain('"svg"');
  });

  it("refuses without touching the editor when a patch cannot apply", async () => {
    const ctx = context();
    const output = JSON.parse(await executeTool("patch_scene", { remove_nodes: ["ghost"] }, ctx)) as JsonObject;
    expect(output.ok).toBe(false);
    expect(output.issues).toEqual(['remove_nodes: no node with id "ghost".']);
    expect(ctx.delivered).toEqual([]);
    const empty = JSON.parse(await executeTool("patch_scene", {}, ctx)) as JsonObject;
    expect(empty.issues).toEqual(["The patch changes nothing."]);
  });

  it("needs a current scene", async () => {
    const ctx = context({ currentScene: null, currentSceneId: null });
    const output = JSON.parse(await executeTool("edit_app_source", { app: "x", edits: [] }, ctx)) as JsonObject;
    expect(output.error).toMatch(/no current scene/);
  });

  it("the partial-update refusal points at the partial tools", async () => {
    const ctx = context();
    const big = scene();
    big.nodes = [
      ...(big.nodes as JsonObject[]),
      { data: { keyword: "a" }, id: "n4", type: "state" },
      { data: { keyword: "b" }, id: "n5", type: "state" },
    ];
    ctx.currentScene = big;
    const output = JSON.parse(
      await executeTool(
        "update_scene",
        { scene: { ...big, nodes: [(big.nodes as JsonObject[])[0]], edges: [] } },
        ctx,
      ),
    ) as JsonObject;
    expect(output.ok).toBe(false);
    expect(String(output.issues)).toMatch(/patch_scene \/ edit_app_source/);
    expect(String(output.issues)).toMatch(/do not ask the user whether to retry/);
  });
});

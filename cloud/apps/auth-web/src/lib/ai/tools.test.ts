import { describe, expect, it } from "vitest";
import { executeTool, toolDefinitions, toolLabels } from "./tools";
import type { ToolContext } from "./tools";

// Registering a tool takes three edits in this file — the definition, the
// label the SPA shows while it runs, and the executor case. Missing the
// second is silent (the raw name leaks into the UI) and missing the third
// only shows up as "Unknown tool" mid-conversation, so assert all three line
// up for every tool rather than only for the newest one.
describe("tool registration", () => {
  it("gives every tool a display label", () => {
    const missing = toolDefinitions
      .map((tool) => tool.name)
      .filter((name) => !toolLabels[name]);
    expect(missing).toEqual([]);
  });

  it("labels nothing that is not a tool", () => {
    const names = new Set(toolDefinitions.map((tool) => tool.name));
    expect(Object.keys(toolLabels).filter((name) => !names.has(name))).toEqual(
      [],
    );
  });

  it("declares every tool as a function with an object parameter schema", () => {
    for (const tool of toolDefinitions) {
      expect(tool.type).toBe("function");
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.parameters.type).toBe("object");
      expect(tool.parameters.additionalProperties).toBe(false);
    }
  });

  it("rejects an unknown tool name instead of throwing", async () => {
    const output = await executeTool("no_such_tool", {}, {} as ToolContext);
    expect(JSON.parse(output)).toEqual({ error: "Unknown tool: no_such_tool" });
  });
});

describe("save_scene", () => {
  const tool = toolDefinitions.find(
    (definition) => definition.name === "save_scene",
  );

  it("takes optional scenes, a name, a description and a source scene", () => {
    const parameters = tool?.parameters as {
      properties: Record<string, unknown>;
      required?: string[];
    };
    expect(parameters.required ?? []).toEqual([]);
    expect(Object.keys(parameters.properties).sort()).toEqual([
      "description",
      "name",
      "scenes",
      "source_scene_id",
    ]);
  });

  // The lineage the tool exists to keep: without source_scene_id a fork of a
  // store scene is indistinguishable from a scene invented in the chat, and
  // the copy loses the original's preview image, tags and description.
  it("tells the model to pass the store id when the scene came from the store", () => {
    expect(tool?.description).toMatch(/source_scene_id/);
    expect(tool?.description).toMatch(/fork/i);
  });
});

describe("add_scene_to_frame", () => {
  const tool = toolDefinitions.find(
    (definition) => definition.name === "add_scene_to_frame",
  );

  it("is registered", () => {
    expect(tool).toBeDefined();
  });

  it("takes a frame and a scene, with an optional pinned version", () => {
    const parameters = tool?.parameters as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(parameters.required).toEqual(["frame_id", "scene_id"]);
    expect(Object.keys(parameters.properties).sort()).toEqual([
      "frame_id",
      "scene_id",
      "scene_version",
    ]);
  });

  // The failure this tool exists to fix: the agent answering "I can't change
  // the frame's assigned scene list from here" and listing the UI steps.
  it("tells the model this replaces the manual Save/Deploy steps", () => {
    expect(tool?.description).toMatch(/do NOT tell the user to do it by hand/i);
    expect(tool?.description).toMatch(/deploy/i);
  });
});

// A model whose scene never reached deliverScenes was being told the payload
// had no scenes, and concluded the editor had rejected the graph it did send
// ("I couldn't deliver the scene because the editor validator rejected the
// scene payload as having no nodes"). Two halves to that: accept the shapes
// models actually send, and when there is genuinely nothing, say nothing was
// inspected rather than that something failed validation.
describe("create_scenes delivery", () => {
  function calendarScene(): Record<string, unknown> {
    return {
      edges: [],
      id: "cal",
      name: "Calendar",
      nodes: [{ data: { keyword: "render" }, id: "n1", type: "event" }],
      settings: { execution: "interpreted" },
    };
  }

  function context(): ToolContext & { delivered: unknown[][] } {
    const delivered: unknown[][] = [];
    return {
      accountId: "a1",
      db: {} as ToolContext["db"],
      delivered,
      emitScenes: (event: { scenes: unknown[] }) => delivered.push(event.scenes),
      prompt: "test",
    } as unknown as ToolContext & { delivered: unknown[][] };
  }

  it("delivers a scene sent as an array", async () => {
    const ctx = context();
    const output = JSON.parse(
      await executeTool("create_scenes", { scenes: [calendarScene()], title: "Calendar" }, ctx),
    ) as Record<string, unknown>;
    expect(output.ok).toBe(true);
    expect(ctx.delivered).toHaveLength(1);
  });

  it("accepts a lone scene object where an array was documented", async () => {
    const ctx = context();
    const output = JSON.parse(
      await executeTool("create_scenes", { scenes: calendarScene(), title: "Calendar" }, ctx),
    ) as Record<string, unknown>;
    expect(output.ok).toBe(true);
    expect(ctx.delivered[0]).toHaveLength(1);
  });

  it("accepts the array re-encoded as a JSON string", async () => {
    const ctx = context();
    const output = JSON.parse(
      await executeTool(
        "create_scenes",
        { scenes: JSON.stringify([calendarScene()]), title: "Calendar" },
        ctx,
      ),
    ) as Record<string, unknown>;
    expect(output.ok).toBe(true);
    expect(ctx.delivered[0]).toHaveLength(1);
  });

  it("says nothing arrived — not that validation failed — when there is no scene", async () => {
    const ctx = context();
    const output = JSON.parse(
      await executeTool("create_scenes", { title: "Calendar" }, ctx),
    ) as { issues: string[]; ok: boolean };
    expect(output.ok).toBe(false);
    expect(output.issues[0]).toContain("No scene arrived");
    expect(output.issues[0]).toContain("not a judgement on the scene you wrote");
    expect(output.issues[0]).toContain("create_scenes");
    expect(ctx.delivered).toEqual([]);
  });
});

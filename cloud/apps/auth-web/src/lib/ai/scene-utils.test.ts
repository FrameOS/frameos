import { describe, expect, it } from "vitest";
import {
  splitStateNodesByApp,
  validateAppKeywords,
  validateScenePayload,
  type JsonObject,
} from "./scene-utils";

function minimalScene(): JsonObject {
  return {
    edges: [
      {
        id: "e1",
        source: "event-1",
        sourceHandle: "next",
        target: "app-1",
        targetHandle: "prev",
        type: "appNodeEdge",
      },
    ],
    id: "scene-1",
    name: "Test scene",
    nodes: [
      { data: { keyword: "render" }, id: "event-1", type: "event" },
      {
        data: { config: { text: "hi" }, keyword: "render/text" },
        id: "app-1",
        type: "app",
      },
    ],
    settings: { execution: "interpreted" },
  };
}

describe("validateScenePayload", () => {
  it("accepts a minimal valid scene", () => {
    expect(validateScenePayload({ scenes: [minimalScene()] })).toEqual([]);
  });

  it("rejects a payload without scenes", () => {
    expect(validateScenePayload({})).toEqual([
      "Scene payload must include a non-empty scenes array.",
    ]);
    expect(validateScenePayload({ scenes: [] })).toEqual([
      "Scene payload must include a non-empty scenes array.",
    ]);
  });

  it("flags a broken scene", () => {
    const scene = minimalScene();
    delete scene.name;
    scene.settings = { execution: "compiled" };
    scene.nodes = [
      { data: { config: {}, keyword: "render/text" }, id: "app-1", type: "app" },
      { data: { config: {}, keyword: "render/text" }, id: "app-1", type: "app" },
    ];
    scene.edges = [{ source: "app-1", target: "ghost" }, "not-an-edge"];
    const issues = validateScenePayload({ scenes: [scene] });
    expect(issues).toContain("Scene 0 is missing id or name.");
    expect(issues).toContain("Scene 0 settings.execution must be 'interpreted'.");
    expect(issues).toContain("Scene 0 has duplicate node id app-1.");
    expect(issues).toContain("Scene 0 is missing a render event node.");
    expect(issues).toContain("Scene 0 edge target 'ghost' is not a valid node id.");
    expect(issues).toContain("Scene 0 has an edge that is not an object.");
  });
});

describe("validateAppKeywords", () => {
  const known = new Set(["render/text", "data/clock"]);

  it("accepts known keywords", () => {
    expect(validateAppKeywords({ scenes: [minimalScene()] }, known)).toEqual([]);
  });

  it("flags hallucinated keywords", () => {
    const scene = minimalScene();
    (scene.nodes as JsonObject[]).push({
      data: { config: {}, keyword: "render/hologram" },
      id: "app-2",
      type: "app",
    });
    const issues = validateAppKeywords({ scenes: [scene] }, known);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("render/hologram");
  });

  it("accepts scene-local apps and inline-source apps", () => {
    const scene = minimalScene();
    scene.apps = { "my/customApp": { name: "Custom", sources: {} } };
    (scene.nodes as JsonObject[]).push(
      {
        data: { config: {}, keyword: "my/customApp" },
        id: "app-2",
        type: "app",
      },
      {
        data: {
          config: {},
          keyword: "inline/app",
          sources: { "app.ts": "export function get() {}" },
        },
        id: "app-3",
        type: "app",
      },
    );
    expect(validateAppKeywords({ scenes: [scene] }, known)).toEqual([]);
  });

  it("flags app nodes without keywords", () => {
    const scene = minimalScene();
    (scene.nodes as JsonObject[]).push({ data: {}, id: "app-2", type: "app" });
    const issues = validateAppKeywords({ scenes: [scene] }, known);
    expect(issues).toEqual(["Scene 0 has an app node without a keyword."]);
  });
});

describe("splitStateNodesByApp", () => {
  it("duplicates a state node feeding multiple apps", () => {
    const stateNode = {
      data: { keyword: "title", value: "" },
      id: "state-1",
      type: "state",
    };
    const edgeToA = {
      source: "state-1",
      sourceHandle: "fieldOutput",
      target: "app-a",
      targetHandle: "fieldInput/text",
      type: "codeNodeEdge",
    };
    const edgeToB = {
      source: "state-1",
      sourceHandle: "fieldOutput",
      target: "app-b",
      targetHandle: "fieldInput/text",
      type: "codeNodeEdge",
    };
    const scene: JsonObject = {
      edges: [edgeToA, edgeToB],
      id: "scene-1",
      name: "Test",
      nodes: [
        stateNode,
        { data: { config: {}, keyword: "render/text" }, id: "app-a", type: "app" },
        { data: { config: {}, keyword: "render/text" }, id: "app-b", type: "app" },
      ],
    };
    splitStateNodesByApp({ scenes: [scene] });

    const nodes = scene.nodes as JsonObject[];
    const stateNodes = nodes.filter((node) => node.type === "state");
    expect(stateNodes).toHaveLength(2);
    expect(stateNodes.every((node) => node.id !== "state-1")).toBe(true);
    expect(
      stateNodes.every((node) => (node.data as JsonObject).keyword === "title"),
    ).toBe(true);
    expect(edgeToA.source).not.toBe("state-1");
    expect(edgeToB.source).not.toBe("state-1");
    expect(edgeToA.source).not.toBe(edgeToB.source);
    expect(stateNodes.map((node) => node.id).sort()).toEqual(
      [edgeToA.source, edgeToB.source].sort(),
    );
  });

  it("leaves a state node feeding a single app untouched", () => {
    const edge = {
      source: "state-1",
      sourceHandle: "fieldOutput",
      target: "app-a",
      targetHandle: "fieldInput/text",
      type: "codeNodeEdge",
    };
    const scene: JsonObject = {
      edges: [edge],
      id: "scene-1",
      name: "Test",
      nodes: [
        { data: { keyword: "title", value: "" }, id: "state-1", type: "state" },
        { data: { config: {}, keyword: "render/text" }, id: "app-a", type: "app" },
      ],
    };
    splitStateNodesByApp({ scenes: [scene] });
    expect((scene.nodes as JsonObject[]).map((node) => node.id)).toEqual([
      "state-1",
      "app-a",
    ]);
    expect(edge.source).toBe("state-1");
  });
});

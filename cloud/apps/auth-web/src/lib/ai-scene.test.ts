import { describe, expect, it } from "vitest";
import {
  normalizeSceneChatTool,
  splitStateNodesByApp,
  validateScenePayload,
  type JsonObject,
} from "./ai-scene";

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

  it("flags a broken scene the way the Python validator does", () => {
    const scene = minimalScene();
    delete scene.name;
    scene.settings = { execution: "compiled" };
    scene.nodes = [
      { data: { config: {}, keyword: "render/text" }, id: "app-1", type: "app" },
      { data: { config: {}, keyword: "render/text" }, id: "app-1", type: "app" },
    ];
    scene.edges = [
      { source: "app-1", target: "ghost" },
      "not-an-edge",
    ];
    const issues = validateScenePayload({ scenes: [scene] });
    expect(issues).toContain("Scene 0 is missing id or name.");
    expect(issues).toContain(
      "Scene 0 settings.execution must be 'interpreted'.",
    );
    expect(issues).toContain("Scene 0 has duplicate node id app-1.");
    expect(issues).toContain("Scene 0 is missing a render event node.");
    expect(issues).toContain(
      "Scene 0 edge target 'ghost' is not a valid node id.",
    );
    expect(issues).toContain("Scene 0 has an edge that is not an object.");
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
    const payload: JsonObject = { scenes: [scene] };
    splitStateNodesByApp(payload);

    const nodes = scene.nodes as JsonObject[];
    const stateNodes = nodes.filter((node) => node.type === "state");
    // The shared state node is replaced by one clone per connected app.
    expect(stateNodes).toHaveLength(2);
    expect(stateNodes.every((node) => node.id !== "state-1")).toBe(true);
    expect(
      stateNodes.every(
        (node) => (node.data as JsonObject).keyword === "title",
      ),
    ).toBe(true);
    // Each edge now points from a distinct clone to its app.
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

describe("normalizeSceneChatTool", () => {
  it("keeps known tools", () => {
    expect(normalizeSceneChatTool("build_scene", false)).toBe("build_scene");
    expect(normalizeSceneChatTool("reply", false)).toBe("reply");
    expect(normalizeSceneChatTool("modify_scene", true)).toBe("modify_scene");
    expect(normalizeSceneChatTool("answer_scene_question", true)).toBe(
      "answer_scene_question",
    );
  });

  it("falls back to answer_frame_question for unknown tools", () => {
    expect(normalizeSceneChatTool("make_coffee", true)).toBe(
      "answer_frame_question",
    );
    expect(normalizeSceneChatTool(undefined, true)).toBe(
      "answer_frame_question",
    );
    expect(normalizeSceneChatTool(42, true)).toBe("answer_frame_question");
  });

  it("degrades scene-scoped tools when no scene is provided", () => {
    expect(normalizeSceneChatTool("modify_scene", false)).toBe(
      "answer_frame_question",
    );
    expect(normalizeSceneChatTool("answer_scene_question", false)).toBe(
      "answer_frame_question",
    );
  });
});

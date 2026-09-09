// @vitest-environment jsdom
//
// appNodeLogic — the per-node view over diagramLogic that every node
// component reads (its node, its edges, the field inputs and outputs wired
// through handles) — built headlessly against the embedded editor's
// frameLogic shim. The 2026-09 review found it had no tests; this also pins
// `deleteCodeField`, which replaced a rename branch that wrote a key the node
// data does not have: deleting a code argument takes its edge, and the code
// node that existed only to feed it, but never a shared source node.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initKea } from "../../../../../../frontend/src/initKea";
import type { DiagramEdge, DiagramNode, FrameScene, FrameType } from "../../../../../../frontend/src/types";

vi.mock("../../../../../../frontend/src/scenes/frame/frameLogic", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../../../frontend/src/scenes/frame/frameLogic")>();
  const { embedFrameLogic } = await import("../../../../../../frontend/src/embed/embedFrameLogic");
  return { ...actual, frameLogic: embedFrameLogic };
});
vi.mock("../../../../../../frontend/src/scenes/frame/panels/Logs/logsLogic", async () => {
  return await import("../../../../../../frontend/src/embed/logsLogicShim");
});

import { embedFrameLogic } from "../../../../../../frontend/src/embed/embedFrameLogic";
import { appNodeLogic } from "../../../../../../frontend/src/scenes/frame/panels/Diagram/appNodeLogic";
import { diagramLogic } from "../../../../../../frontend/src/scenes/frame/panels/Diagram/diagramLogic";

const frameId = 1 as unknown as FrameType["id"];
const sceneId = "app-node-scene";

const node = (id: string, type: string, data: Record<string, unknown>, x = 0): DiagramNode =>
  ({ id, type, position: { x, y: 0 }, data }) as DiagramNode;

const edge = (id: string, source: string, sourceHandle: string, target: string, targetHandle: string): DiagramEdge =>
  ({ id, source, sourceHandle, target, targetHandle }) as DiagramEdge;

// render → weather (app) → target (code, arguments a and b)
//   a  ← "onlyA"  (a code node with no other connection: dedicated)
//   b  ← "weather" (which also feeds "other": shared)
const scene = {
  id: sceneId,
  name: "App node",
  nodes: [
    node("render", "event", { keyword: "render" }),
    node("weather", "app", { keyword: "weather", config: { city: "Tallinn" } }, 100),
    node("target", "code", { code: "a + b", codeArgs: [{ name: "a", type: "string" }, { name: "b", type: "string" }] }, 200),
    node("onlyA", "code", { code: "'A'" }, 300),
    node("other", "code", { code: "shared", codeArgs: [{ name: "shared", type: "string" }] }, 400),
  ],
  edges: [
    edge("e-render-weather", "render", "next", "weather", "prev"),
    edge("e-weather-city", "onlyA", "fieldOutput", "weather", "fieldInput/city"),
    edge("e-a", "onlyA", "fieldOutput", "target", "codeField/a"),
    edge("e-b", "weather", "fieldOutput", "target", "codeField/b"),
    edge("e-shared", "weather", "fieldOutput", "other", "codeField/shared"),
    edge("e-out", "weather", "field/city", "render", "prev"),
  ],
  fields: [],
  customEvents: [],
  settings: { execution: "interpreted" },
} as unknown as FrameScene;

type EmbedTestWindow = Window & { FRAMEOS_EMBEDDED_NO_BACKEND?: boolean };
const testWindow = window as EmbedTestWindow;

let unmount: (() => void)[] = [];

function mountNode(nodeId: string): ReturnType<typeof appNodeLogic> {
  const logic = appNodeLogic({ frameId, sceneId, nodeId });
  unmount.push(logic.mount());
  return logic;
}

function sceneInForm(): FrameScene {
  return embedFrameLogic({ frameId }).values.frameForm.scenes!.find((candidate) => candidate.id === sceneId)!;
}

beforeEach(() => {
  testWindow.FRAMEOS_EMBEDDED_NO_BACKEND = true;
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("null", { status: 404 })));
  initKea({ memoryRouter: true });
  embedFrameLogic({ frameId }).mount();
  embedFrameLogic({ frameId }).actions.initEmbedFrame({
    id: frameId,
    name: "Embedded",
    scenes: [scene],
    width: 800,
    height: 480,
  } as Partial<FrameType>);
  unmount = [diagramLogic({ frameId, sceneId }).mount()];
});

afterEach(() => {
  for (const fn of unmount.reverse()) {
    fn();
  }
  vi.unstubAllGlobals();
  delete testWindow.FRAMEOS_EMBEDDED_NO_BACKEND;
});

describe("appNodeLogic selectors", () => {
  it("finds its node and only the edges touching it", () => {
    const logic = mountNode("weather");
    expect(logic.values.nodeId).toBe("weather");
    expect(logic.values.node?.type).toBe("app");
    expect(logic.values.nodeConfig).toEqual({ city: "Tallinn" });
    expect(logic.values.nodeEdges.map((e) => e.id).sort()).toEqual([
      "e-b",
      "e-out",
      "e-render-weather",
      "e-shared",
      "e-weather-city",
    ]);
    expect(mountNode("missing").values.node).toBeNull();
  });

  it("lists the fields wired in through fieldInput handles and out through field handles", () => {
    const logic = mountNode("weather");
    expect(logic.values.codeArgs).toEqual(["city"]);
    expect(logic.values.fieldInputFields).toEqual(["city"]);
    expect(logic.values.nodeOutputFields).toEqual(["city"]);
    const target = mountNode("target");
    // codeField/ handles are the code node's own arguments, not field inputs.
    expect(target.values.fieldInputFields).toEqual([]);
    expect(target.values.nodeOutputFields).toEqual([]);
  });

  it("follows the diagram's selection", () => {
    const logic = mountNode("weather");
    expect(logic.values.isSelected).toBe(false);
    logic.actions.select();
    expect(logic.values.isSelected).toBe(true);
    expect(diagramLogic({ frameId, sceneId }).values.selectedNode?.id).toBe("weather");
    mountNode("render").actions.select();
    expect(logic.values.isSelected).toBe(false);
  });
});

describe("appNodeLogic deleteCodeField", () => {
  it("removes the argument, its edge and the code node that existed only for it", () => {
    const logic = mountNode("target");
    logic.actions.deleteCodeField("a");
    const diagram = diagramLogic({ frameId, sceneId });
    expect((logic.values.node?.data as { codeArgs: { name: string }[] }).codeArgs.map((a) => a.name)).toEqual(["b"]);
    expect(diagram.values.rawEdges.map((e) => e.id).sort()).toEqual([
      "e-b",
      "e-out",
      "e-render-weather",
      "e-shared",
      "e-weather-city",
    ]);
    // "onlyA" also feeds weather's city, so it is not dedicated to `a`.
    expect(diagram.values.nodes.map((n) => n.id)).toContain("onlyA");
  });

  it("deletes a code node whose only connection was the argument", () => {
    const diagram = diagramLogic({ frameId, sceneId });
    diagram.actions.setEdges(diagram.values.rawEdges.filter((e) => e.id !== "e-weather-city"));
    const logic = mountNode("target");
    logic.actions.deleteCodeField("a");
    expect(diagram.values.nodes.map((n) => n.id)).not.toContain("onlyA");
    expect(diagram.values.rawEdges.find((e) => e.id === "e-a")).toBeUndefined();
    expect(sceneInForm().nodes.map((n) => n.id)).not.toContain("onlyA");
    expect(sceneInForm().edges.map((e) => e.id)).not.toContain("e-a");
  });

  it("keeps a shared source node and only drops the edge", () => {
    const logic = mountNode("target");
    logic.actions.deleteCodeField("b");
    const diagram = diagramLogic({ frameId, sceneId });
    expect((logic.values.node?.data as { codeArgs: { name: string }[] }).codeArgs.map((a) => a.name)).toEqual(["a"]);
    expect(diagram.values.nodes.map((n) => n.id)).toContain("weather");
    expect(diagram.values.rawEdges.find((e) => e.id === "e-b")).toBeUndefined();
    expect(diagram.values.rawEdges.find((e) => e.id === "e-shared")).toBeDefined();
    expect((sceneInForm().nodes.find((n) => n.id === "target")?.data as { codeArgs: unknown[] }).codeArgs).toHaveLength(
      1
    );
  });
});

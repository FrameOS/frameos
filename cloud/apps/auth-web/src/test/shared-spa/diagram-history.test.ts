// @vitest-environment jsdom
//
// The scene editor's undo/redo, built headlessly against the embedded
// editor's frameLogic shim (the same alias frontend/build.mjs applies). Pins
// the 2026-09 review findings: history covered only {nodes, edges, apps} so
// deleting a state field was not undoable; the picker's node + edge landed as
// two entries; the ignore flag cleared on a setTimeout(0), so an edit in the
// same tick after Cmd+Z went unrecorded; and there was no Ctrl+Y.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initKea } from "../../../../../../frontend/src/initKea";
import type { DiagramNode, FrameScene, FrameType, StateField } from "../../../../../../frontend/src/types";

vi.mock("../../../../../../frontend/src/scenes/frame/frameLogic", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../../../frontend/src/scenes/frame/frameLogic")>();
  const { embedFrameLogic } = await import("../../../../../../frontend/src/embed/embedFrameLogic");
  return { ...actual, frameLogic: embedFrameLogic };
});
vi.mock("../../../../../../frontend/src/scenes/frame/panels/Logs/logsLogic", async () => {
  return await import("../../../../../../frontend/src/embed/logsLogicShim");
});

import { embedFrameLogic } from "../../../../../../frontend/src/embed/embedFrameLogic";
import { diagramLogic } from "../../../../../../frontend/src/scenes/frame/panels/Diagram/diagramLogic";

const frameId = 1 as unknown as FrameType["id"];
const sceneId = "history-scene";

const renderNode: DiagramNode = {
  id: "render",
  type: "event",
  position: { x: 0, y: 0 },
  data: { keyword: "render" },
} as DiagramNode;

const scene = {
  id: sceneId,
  name: "History",
  nodes: [renderNode],
  edges: [],
  fields: [],
  customEvents: [],
  settings: { execution: "interpreted" },
} as unknown as FrameScene;

type EmbedTestWindow = Window & { FRAMEOS_EMBEDDED_NO_BACKEND?: boolean };
const testWindow = window as EmbedTestWindow;

const cityField: StateField = { name: "city", label: "City", type: "string", persist: "disk", access: "public" };

function sceneInForm(): FrameScene {
  return embedFrameLogic({ frameId }).values.frameForm.scenes!.find((candidate) => candidate.id === sceneId)!;
}

function keydown(key: string, modifiers: Partial<KeyboardEventInit> = {}): void {
  window.dispatchEvent(new KeyboardEvent("keydown", { key, ctrlKey: true, bubbles: true, ...modifiers }));
}

let unmountDiagram: () => void = () => {};

beforeEach(() => {
  vi.useFakeTimers();
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
  unmountDiagram = diagramLogic({ frameId, sceneId }).mount();
});

afterEach(() => {
  unmountDiagram();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete testWindow.FRAMEOS_EMBEDDED_NO_BACKEND;
});

describe("diagramLogic history", () => {
  it("starts with nothing to undo and records a node insertion", () => {
    const logic = diagramLogic({ frameId, sceneId });
    expect(logic.values.canUndo).toBe(false);
    logic.actions.setNodes([...logic.values.nodes, { ...renderNode, id: "second", position: { x: 10, y: 10 } }]);
    expect(logic.values.nodes).toHaveLength(2);
    expect(sceneInForm().nodes).toHaveLength(2);
    expect(logic.values.canUndo).toBe(true);
    logic.actions.requestUndo();
    expect(logic.values.nodes).toHaveLength(1);
    expect(sceneInForm().nodes).toHaveLength(1);
    expect(logic.values.canRedo).toBe(true);
    logic.actions.requestRedo();
    expect(logic.values.nodes).toHaveLength(2);
    expect(sceneInForm().nodes).toHaveLength(2);
  });

  it("covers state fields edited through the frame form", () => {
    const logic = diagramLogic({ frameId, sceneId });
    embedFrameLogic({ frameId }).actions.updateScene(sceneId, { fields: [cityField] });
    expect(sceneInForm().fields).toEqual([cityField]);
    // Field edits are debounced like typing.
    vi.advanceTimersByTime(400);
    expect(logic.values.canUndo).toBe(true);
    logic.actions.requestUndo();
    expect(sceneInForm().fields).toEqual([]);
    logic.actions.requestRedo();
    expect(sceneInForm().fields).toEqual([cityField]);
  });

  it("records a picker insertion (node + edge) as one entry", () => {
    const logic = diagramLogic({ frameId, sceneId });
    const inserted = { ...renderNode, id: "inserted", type: "state", data: { keyword: "x" } } as DiagramNode;
    logic.actions.setNodesAndEdges(
      [...logic.values.nodes, inserted],
      [{ id: "e1", source: "inserted", sourceHandle: "fieldOutput", target: "render", targetHandle: "prev" }]
    );
    expect(logic.values.nodes).toHaveLength(2);
    expect(logic.values.rawEdges).toHaveLength(1);
    expect(sceneInForm().edges).toHaveLength(1);
    expect(logic.values.history.past).toHaveLength(2);
    logic.actions.requestUndo();
    expect(logic.values.nodes).toHaveLength(1);
    expect(logic.values.rawEdges).toHaveLength(0);
    expect(logic.values.canUndo).toBe(false);
  });

  it("records an edit made right after undo, in the same tick", () => {
    const logic = diagramLogic({ frameId, sceneId });
    logic.actions.setNodes([...logic.values.nodes, { ...renderNode, id: "second", position: { x: 10, y: 10 } }]);
    logic.actions.requestUndo();
    expect(logic.values.nodes).toHaveLength(1);
    // Under the old setTimeout(0) reset this delete was invisible to history.
    logic.actions.setNodes([]);
    expect(logic.values.nodes).toHaveLength(0);
    expect(logic.values.canUndo).toBe(true);
    expect(logic.values.canRedo).toBe(false);
    logic.actions.requestUndo();
    expect(logic.values.nodes).toHaveLength(1);
  });

  it("answers Ctrl+Z, Ctrl+Y and Ctrl+Shift+Z", () => {
    const logic = diagramLogic({ frameId, sceneId });
    logic.actions.setNodes([...logic.values.nodes, { ...renderNode, id: "second", position: { x: 10, y: 10 } }]);
    keydown("z");
    expect(logic.values.nodes).toHaveLength(1);
    keydown("y");
    expect(logic.values.nodes).toHaveLength(2);
    keydown("z");
    expect(logic.values.nodes).toHaveLength(1);
    keydown("z", { shiftKey: true });
    expect(logic.values.nodes).toHaveLength(2);
  });
});

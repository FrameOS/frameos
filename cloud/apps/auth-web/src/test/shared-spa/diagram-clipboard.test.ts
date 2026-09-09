// @vitest-environment jsdom
//
// The scene editor's copy, paste and "has this scene changed" logic, built
// headlessly against the embedded editor's frameLogic shim (the same alias
// frontend/build.mjs applies). The 2026-09 review found diagramLogic had no
// tests at all; this pins the clipboard payload shapes (a bare node for one
// node, {nodes, edges} for a selection, secrets stripped either way), the
// same-tab paste fallback used when navigator.clipboard is missing (the
// default http://<ip>:8989 self-hosted deployment), id remapping on paste,
// and that hasChanges compares against the stored frame, not the form.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initKea } from "../../../../../../frontend/src/initKea";
import type { AppConfig, DiagramNode, FrameScene, FrameType } from "../../../../../../frontend/src/types";

vi.mock("../../../../../../frontend/src/scenes/frame/frameLogic", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../../../frontend/src/scenes/frame/frameLogic")>();
  const { embedFrameLogic } = await import("../../../../../../frontend/src/embed/embedFrameLogic");
  return { ...actual, frameLogic: embedFrameLogic };
});
vi.mock("../../../../../../frontend/src/scenes/frame/panels/Logs/logsLogic", async () => {
  return await import("../../../../../../frontend/src/embed/logsLogicShim");
});
// The package lives only in frontend/node_modules (this workspace does not
// depend on it), so the mock names the resolved file.
const copyToClipboard = vi.fn();
vi.mock("../../../../../../frontend/node_modules/copy-to-clipboard/index.js", () => ({
  default: (text: string) => copyToClipboard(text),
}));

import { embedFrameLogic } from "../../../../../../frontend/src/embed/embedFrameLogic";
import { appsModel } from "../../../../../../frontend/src/models/appsModel";
import { framesModel } from "../../../../../../frontend/src/models/framesModel";
import { diagramLogic } from "../../../../../../frontend/src/scenes/frame/panels/Diagram/diagramLogic";

const frameId = 1 as unknown as FrameType["id"];
const sceneId = "clipboard-scene";

const renderNode: DiagramNode = {
  id: "render",
  type: "event",
  position: { x: 0, y: 0 },
  data: { keyword: "render" },
} as DiagramNode;

// A catalog app with one secret field, the way an API key is declared.
const weatherApp: AppConfig = {
  name: "Weather",
  category: "data",
  fields: [
    { name: "city", type: "string", label: "City", value: "" },
    { name: "apiKey", type: "string", label: "API key", value: "", secret: true },
  ],
} as unknown as AppConfig;

const weatherNode: DiagramNode = {
  id: "weather",
  type: "app",
  position: { x: 100, y: 100 },
  data: { keyword: "weather", config: { city: "Tallinn", apiKey: "sk-secret" } },
} as DiagramNode;

const scene = {
  id: sceneId,
  name: "Clipboard",
  nodes: [renderNode, weatherNode],
  // No `type` on the edge, as in a hand-written, imported or AI-built scene:
  // the editor only stamps its render type in the `edges` selector, and
  // hasChanges used to compare those decorated edges with the stored ones, so
  // such a scene showed as changed from the moment it opened.
  edges: [
    {
      id: "e-render-weather",
      source: "render",
      sourceHandle: "next",
      target: "weather",
      targetHandle: "prev",
    },
  ],
  fields: [],
  customEvents: [],
  settings: { execution: "interpreted" },
} as unknown as FrameScene;

const frame = { id: frameId, name: "Embedded", scenes: [scene], width: 800, height: 480 } as Partial<FrameType>;

type EmbedTestWindow = Window & { FRAMEOS_EMBEDDED_NO_BACKEND?: boolean };
const testWindow = window as EmbedTestWindow;

function sceneInForm(): FrameScene {
  return embedFrameLogic({ frameId }).values.frameForm.scenes!.find((candidate) => candidate.id === sceneId)!;
}

function lastCopied(): unknown {
  return JSON.parse(copyToClipboard.mock.calls.at(-1)?.[0] as string);
}

let unmountDiagram: () => void = () => {};

beforeEach(() => {
  vi.useFakeTimers();
  copyToClipboard.mockClear();
  testWindow.FRAMEOS_EMBEDDED_NO_BACKEND = true;
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("null", { status: 404 })));
  initKea({ memoryRouter: true });
  appsModel.mount();
  appsModel.actions.loadAppsSuccess({ weather: weatherApp });
  framesModel.mount();
  framesModel.actions.addFrame(frame as FrameType);
  embedFrameLogic({ frameId }).mount();
  embedFrameLogic({ frameId }).actions.initEmbedFrame(frame);
  unmountDiagram = diagramLogic({ frameId, sceneId }).mount();
});

afterEach(() => {
  unmountDiagram();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete testWindow.FRAMEOS_EMBEDDED_NO_BACKEND;
});

describe("diagramLogic hasChanges", () => {
  it("is false while the diagram matches the stored frame and true once a node is added", () => {
    const logic = diagramLogic({ frameId, sceneId });
    expect(logic.values.hasChanges).toBe(false);
    logic.actions.setNodes([...logic.values.nodes, { ...renderNode, id: "second", position: { x: 10, y: 10 } }]);
    expect(logic.values.hasChanges).toBe(true);
    // Selection is a view concern, not a change.
    logic.actions.setNodes(logic.values.nodes.filter((node) => node.id !== "second"));
    expect(logic.values.hasChanges).toBe(false);
    logic.actions.selectNode("render");
    expect(logic.values.nodes.find((node) => node.id === "render")?.selected).toBe(true);
    expect(logic.values.hasChanges).toBe(false);
  });

  it("clears once the stored frame catches up with the form", () => {
    const logic = diagramLogic({ frameId, sceneId });
    logic.actions.setNodes([...logic.values.nodes, { ...renderNode, id: "second", position: { x: 10, y: 10 } }]);
    expect(logic.values.hasChanges).toBe(true);
    framesModel.actions.addFrame({ ...frame, scenes: [sceneInForm()] } as FrameType);
    expect(logic.values.hasChanges).toBe(false);
  });
});

describe("diagramLogic copy", () => {
  it("copies one unselected node as a bare node, without its secrets or view state", () => {
    const logic = diagramLogic({ frameId, sceneId });
    logic.actions.setNodes(logic.values.nodes.map((node) => ({ ...node, selected: false })));
    logic.actions.copyAppJSON("weather");
    const copied = lastCopied() as DiagramNode;
    expect(copied.id).toBe("weather");
    expect("nodes" in copied).toBe(false);
    expect((copied.data as { config: Record<string, unknown> }).config).toEqual({ city: "Tallinn" });
    expect("selected" in copied).toBe(false);
  });

  it("copies a selection as {nodes, edges} keeping only edges inside the selection", () => {
    const logic = diagramLogic({ frameId, sceneId });
    const stray = { ...renderNode, id: "stray", selected: false, position: { x: 300, y: 300 } };
    logic.actions.setNodesAndEdges(
      [...logic.values.nodes.map((node) => ({ ...node, selected: true })), stray],
      [...logic.values.rawEdges, { id: "e-stray", source: "weather", sourceHandle: "next", target: "stray", targetHandle: "prev" }]
    );
    logic.actions.copySelectedNodes();
    const copied = lastCopied() as { nodes: DiagramNode[]; edges: { id: string }[] };
    expect(copied.nodes.map((node) => node.id).sort()).toEqual(["render", "weather"]);
    expect(copied.edges.map((edge) => edge.id)).toEqual(["e-render-weather"]);
    expect((copied.nodes.find((node) => node.id === "weather")!.data as { config: unknown }).config).toEqual({
      city: "Tallinn",
    });
  });
});

describe("diagramLogic paste", () => {
  it("falls back to the last copied payload and pastes fresh, selected, remapped copies", async () => {
    const logic = diagramLogic({ frameId, sceneId });
    expect(navigator.clipboard).toBeUndefined();
    logic.actions.setNodes(logic.values.nodes.map((node) => ({ ...node, selected: true })));
    logic.actions.copySelectedNodes();
    await logic.asyncActions.pasteFromClipboard();
    vi.advanceTimersByTime(300);

    const nodes = logic.values.nodes;
    expect(nodes).toHaveLength(4);
    const pasted = nodes.filter((node) => !["render", "weather"].includes(node.id));
    expect(pasted).toHaveLength(2);
    for (const node of pasted) {
      expect(node.selected).toBe(true);
      expect(node.id).not.toMatch(/^(render|weather)$/);
    }
    for (const node of nodes.filter((node) => ["render", "weather"].includes(node.id))) {
      expect(node.selected).toBeFalsy();
    }
    // Pasted copies land offset from the originals, not on top of them.
    const pastedRender = pasted.find((node) => node.type === "event")!;
    expect(pastedRender.position).toEqual({ x: 40, y: 40 });

    const edges = logic.values.rawEdges;
    expect(edges).toHaveLength(2);
    const pastedIds = new Set(pasted.map((node) => node.id));
    const pastedEdge = edges.find((edge) => edge.id !== "e-render-weather")!;
    expect(pastedIds.has(pastedEdge.source)).toBe(true);
    expect(pastedIds.has(pastedEdge.target)).toBe(true);
    expect(pastedEdge.selected).toBeFalsy();

    expect(sceneInForm().nodes).toHaveLength(4);
    expect(sceneInForm().edges).toHaveLength(2);
    expect(logic.values.hasChanges).toBe(true);
  });

  it("pastes a bare node payload as one new node", async () => {
    const logic = diagramLogic({ frameId, sceneId });
    logic.actions.setNodes(logic.values.nodes.map((node) => ({ ...node, selected: false })));
    logic.actions.copyAppJSON("weather");
    await logic.asyncActions.pasteFromClipboard();
    vi.advanceTimersByTime(300);
    expect(logic.values.nodes).toHaveLength(3);
    const pasted = logic.values.nodes.find((node) => node.selected)!;
    expect(pasted.id).not.toBe("weather");
    expect(pasted.type).toBe("app");
    expect((pasted.data as { config: Record<string, unknown> }).config).toEqual({ city: "Tallinn" });
    expect(logic.values.rawEdges).toHaveLength(1);
  });
});

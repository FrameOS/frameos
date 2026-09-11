// @vitest-environment jsdom
//
// newNodePickerLogic.selectNewNodeOption — the ~300-line listener that turns
// a picker choice into a node and the edges around it — had no test
// (2026-09 review). Built headlessly against the embedded editor's frameLogic
// shim, like diagram-clipboard and diagram-history. Pins canvas insertion,
// splicing a node into an existing next/prev edge from either side, "+" on a
// code node adding the argument and its producer as one undo step, a state
// node plus scene field for an app input, a code node for an output, disabled
// options doing nothing, and that the touched nodes are re-measured on the
// next frame instead of 200 ms later (the window in which an edge into a new
// handle had no anchor).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initKea } from "../../../../../../frontend/src/initKea";
import type { AppConfig, CodeNodeData, DiagramNode, FrameScene, FrameType } from "../../../../../../frontend/src/types";

vi.mock("../../../../../../frontend/src/scenes/frame/frameLogic", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../../../frontend/src/scenes/frame/frameLogic")>();
  const { embedFrameLogic } = await import("../../../../../../frontend/src/embed/embedFrameLogic");
  return { ...actual, frameLogic: embedFrameLogic };
});
vi.mock("../../../../../../frontend/src/scenes/frame/panels/Logs/logsLogic", async () => {
  return await import("../../../../../../frontend/src/embed/logsLogicShim");
});

import { embedFrameLogic } from "../../../../../../frontend/src/embed/embedFrameLogic";
import { appsModel } from "../../../../../../frontend/src/models/appsModel";
import { framesModel } from "../../../../../../frontend/src/models/framesModel";
import { diagramLogic } from "../../../../../../frontend/src/scenes/frame/panels/Diagram/diagramLogic";
import {
  CANVAS_NODE_ID,
  newNodePickerLogic,
  type NewNodePicker,
  type OptionWithType,
} from "../../../../../../frontend/src/scenes/frame/panels/Diagram/newNodePickerLogic";

const frameId = 1 as unknown as FrameType["id"];
const sceneId = "picker-scene";

const weatherApp: AppConfig = {
  name: "Weather",
  category: "data",
  fields: [{ name: "city", type: "string", label: "City", value: "" }],
} as unknown as AppConfig;

const scene = {
  id: sceneId,
  name: "Picker",
  nodes: [
    { id: "render", type: "event", position: { x: 0, y: 0 }, data: { keyword: "render" } },
    { id: "weather", type: "app", position: { x: 300, y: 0 }, data: { keyword: "weather", config: {} } },
    {
      id: "code1",
      type: "code",
      position: { x: 300, y: 300 },
      data: { codeJS: "return 1", codeArgs: [], codeOutputs: [{ name: "out", type: "string" }] },
    },
  ],
  edges: [{ id: "e-render-weather", source: "render", sourceHandle: "next", target: "weather", targetHandle: "prev" }],
  fields: [],
  customEvents: [],
  settings: { execution: "interpreted" },
} as unknown as FrameScene;

const frame = { id: frameId, name: "Embedded", scenes: [scene], width: 800, height: 480 } as Partial<FrameType>;
const originalIds = ["render", "weather", "code1"];

type EmbedTestWindow = Window & { FRAMEOS_EMBEDDED_NO_BACKEND?: boolean };
const testWindow = window as EmbedTestWindow;

const updateNodeInternals = vi.fn();
const diagram = () => diagramLogic({ frameId, sceneId });
const picker = () => newNodePickerLogic({ frameId, sceneId, updateNodeInternals });

function from(nodeId: string, handleId: string, handleType: string): NewNodePicker {
  return { screenX: 0, screenY: 0, diagramX: 100, diagramY: 200, nodeId, handleId, handleType };
}

function option(value: string, keyword: string, extra: Partial<OptionWithType> = {}): OptionWithType {
  return { label: value, value, keyword, type: "string", ...extra } as OptionWithType;
}

function insertedNodes(): DiagramNode[] {
  return diagram().values.nodes.filter((node) => !originalIds.includes(node.id));
}

/** Edges as `source.handle->target.handle`, the inserted node written NEW. */
function edgeSummary(): string[] {
  const inserted = new Set(insertedNodes().map((node) => node.id));
  const name = (id: string): string => (inserted.has(id) ? "NEW" : id);
  return diagram()
    .values.rawEdges.map((edge) => `${name(edge.source)}.${edge.sourceHandle}->${name(edge.target)}.${edge.targetHandle}`)
    .sort();
}

function codeNode(): CodeNodeData {
  return diagram().values.nodes.find((node) => node.id === "code1")!.data as CodeNodeData;
}

function sceneInForm(): FrameScene {
  return embedFrameLogic({ frameId }).values.frameForm.scenes!.find((candidate) => candidate.id === sceneId)!;
}

let unmount: () => void = () => {};

beforeEach(() => {
  vi.useFakeTimers();
  updateNodeInternals.mockClear();
  // Animation frames run at once, and no timer is advanced: a handle refresh
  // still parked on a setTimeout would not be seen by these tests.
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 0;
  });
  testWindow.FRAMEOS_EMBEDDED_NO_BACKEND = true;
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("null", { status: 404 })));
  initKea({ memoryRouter: true });
  appsModel.mount();
  appsModel.actions.loadAppsSuccess({ weather: weatherApp });
  framesModel.mount();
  framesModel.actions.addFrame(frame as FrameType);
  embedFrameLogic({ frameId }).mount();
  embedFrameLogic({ frameId }).actions.initEmbedFrame(frame);
  const unmountDiagram = diagram().mount();
  const unmountPicker = picker().mount();
  unmount = () => {
    unmountPicker();
    unmountDiagram();
  };
});

afterEach(() => {
  unmount();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete testWindow.FRAMEOS_EMBEDDED_NO_BACKEND;
});

describe("newNodePickerLogic.selectNewNodeOption", () => {
  it("adds a JavaScript code node where the canvas was clicked, as one undo step", async () => {
    await picker().asyncActions.selectNewNodeOption(from(CANVAS_NODE_ID, "", "canvas"), option("code", "code"));
    expect(insertedNodes()).toHaveLength(1);
    const node = insertedNodes()[0]!;
    expect(node.type).toBe("code");
    expect(node.position).toEqual({ x: 100, y: 200 });
    expect(node.data).toEqual({ codeJS: "", codeArgs: [], codeOutputs: [] });
    expect(sceneInForm().nodes).toHaveLength(4);
    expect(updateNodeInternals).toHaveBeenCalledWith(node.id);

    diagram().actions.requestUndo();
    expect(insertedNodes()).toHaveLength(0);
  });

  it("splices a node into the next edge it was pulled from", async () => {
    await picker().asyncActions.selectNewNodeOption(
      from("render", "next", "source"),
      option(`scene/${sceneId}`, sceneId, { type: "scene" })
    );
    expect(insertedNodes().map((node) => node.type)).toEqual(["scene"]);
    expect(edgeSummary()).toEqual(["NEW.next->weather.prev", "render.next->NEW.prev"]);
    expect(sceneInForm().edges).toHaveLength(2);

    diagram().actions.requestUndo();
    expect(insertedNodes()).toHaveLength(0);
    expect(edgeSummary()).toEqual(["render.next->weather.prev"]);
  });

  it("splices a node in before a prev handle", async () => {
    await picker().asyncActions.selectNewNodeOption(
      from("weather", "prev", "target"),
      option("dispatch/setSceneState", "setSceneState")
    );
    const node = insertedNodes()[0]!;
    expect(node.type).toBe("dispatch");
    expect(node.data).toEqual({ keyword: "setSceneState", config: {} });
    expect(edgeSummary()).toEqual(["NEW.next->weather.prev", "render.next->NEW.prev"]);
  });

  it("'+' on a code node adds the argument, its producer and the edge as one undo step", async () => {
    await picker().asyncActions.selectNewNodeOption(from("code1", "codeField/+", "target"), option("code", "+"));
    expect(codeNode().codeArgs).toEqual([{ name: "arg", type: "string" }]);
    const producer = insertedNodes()[0]!;
    expect(producer.type).toBe("code");
    expect((producer.data as CodeNodeData).codeOutputs).toEqual([{ name: "arg", type: "string" }]);
    expect(edgeSummary()).toContain("NEW.fieldOutput->code1.codeField/arg");
    // Both ends re-measured without waiting on a timer.
    expect(updateNodeInternals).toHaveBeenCalledWith("code1");
    expect(updateNodeInternals).toHaveBeenCalledWith(producer.id);

    diagram().actions.requestUndo();
    expect(insertedNodes()).toHaveLength(0);
    expect(codeNode().codeArgs).toEqual([]);
    expect(edgeSummary()).toEqual(["render.next->weather.prev"]);
  });

  it("gives an app input a state node, its edge and a new scene field", async () => {
    await picker().asyncActions.selectNewNodeOption(from("weather", "fieldInput/city", "target"), option("state", "city"));
    const node = insertedNodes()[0]!;
    expect(node.type).toBe("state");
    expect(node.data).toEqual({ keyword: "city" });
    expect(edgeSummary()).toContain("NEW.fieldOutput->weather.fieldInput/city");
    vi.advanceTimersByTime(500);
    expect(sceneInForm().fields).toEqual([
      expect.objectContaining({ name: "city", label: "City", type: "string", persist: "disk", access: "public" }),
    ]);
  });

  it("feeds a code node's output into a new code node named after it", async () => {
    await picker().asyncActions.selectNewNodeOption(from("code1", "fieldOutput", "source"), option("code", "out"));
    const node = insertedNodes()[0]!;
    expect((node.data as CodeNodeData).codeArgs).toEqual([{ name: "out", type: "string" }]);
    expect(edgeSummary()).toContain("code1.fieldOutput->NEW.codeField/out");
  });

  it("does nothing for a disabled option", async () => {
    await picker().asyncActions.selectNewNodeOption(
      from(CANVAS_NODE_ID, "", "canvas"),
      option("code", "code", { disabledReason: "Not available on this device" })
    );
    expect(insertedNodes()).toHaveLength(0);
    expect(diagram().values.canUndo).toBe(false);
  });
});

// @vitest-environment jsdom
//
// The scene JSON editor's logic, built headlessly against the embedded
// editor's frameLogic shim (the alias frontend/build.mjs applies). Pins how a
// scene is printed, when the editor counts as changed or broken, and that a
// save goes through sanitizeScene: the embed's updateScene does not sanitize,
// so hand-typed JSON with a node lacking `position` used to take reactflow
// down — the exact crash sanitizeIncomingScenes guards against inbound
// (2026-09 review).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initKea } from "../../../../../../frontend/src/initKea";
import type { FrameScene, FrameType } from "../../../../../../frontend/src/types";

vi.mock("../../../../../../frontend/src/scenes/frame/frameLogic", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../../../frontend/src/scenes/frame/frameLogic")>();
  const { embedFrameLogic } = await import("../../../../../../frontend/src/embed/embedFrameLogic");
  return { ...actual, frameLogic: embedFrameLogic };
});
vi.mock("../../../../../../frontend/src/scenes/frame/panels/Logs/logsLogic", async () => {
  return await import("../../../../../../frontend/src/embed/logsLogicShim");
});

import { embedFrameLogic } from "../../../../../../frontend/src/embed/embedFrameLogic";
import { sceneJSONLogic } from "../../../../../../frontend/src/scenes/frame/panels/SceneJSON/sceneJSONLogic";

const frameId = 1 as unknown as FrameType["id"];
const sceneId = "json-scene";

const scene = {
  id: sceneId,
  name: "JSON",
  nodes: [{ id: "render", type: "event", position: { x: 0, y: 0 }, data: { keyword: "render" } }],
  edges: [],
  fields: [],
  customEvents: [],
  settings: { execution: "interpreted", refreshInterval: 60, backgroundColor: "#000000" },
} as unknown as FrameScene;

type EmbedTestWindow = Window & { FRAMEOS_EMBEDDED_NO_BACKEND?: boolean };
const testWindow = window as EmbedTestWindow;

function sceneInForm(): FrameScene {
  return embedFrameLogic({ frameId }).values.frameForm.scenes!.find((candidate) => candidate.id === sceneId)!;
}

function logic() {
  return sceneJSONLogic({ frameId, sceneId });
}

let unmount: () => void = () => {};

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
  unmount = logic().mount();
});

afterEach(() => {
  unmount();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete testWindow.FRAMEOS_EMBEDDED_NO_BACKEND;
});

describe("sceneJSONLogic", () => {
  it("prints the scene with id, name, settings, fields, nodes, edges first and no default key", () => {
    const printed = JSON.parse(logic().values.sceneJSON) as Record<string, unknown>;
    expect(Object.keys(printed).slice(0, 6)).toEqual(["id", "name", "settings", "fields", "nodes", "edges"]);
    expect("default" in printed).toBe(false);
    expect(printed.name).toBe("JSON");
    expect(logic().values.sceneName).toBe("JSON");
  });

  it("counts as changed only while the text differs from the printed scene", () => {
    expect(logic().values.hasChanges).toBe(false);
    const printed = logic().values.sceneJSON;
    logic().actions.setEditedSceneJSON(printed.replace('"JSON"', '"Renamed"'));
    expect(logic().values.hasChanges).toBe(true);
    logic().actions.setEditedSceneJSON(printed);
    expect(logic().values.hasChanges).toBe(false);
  });

  it("flags unparsable text", () => {
    expect(logic().values.hasError).toBe(false);
    logic().actions.setEditedSceneJSON("{ not json");
    expect(logic().values.hasError).toBe(true);
    expect(logic().values.hasChanges).toBe(true);
  });

  it("saves valid JSON into the frame form, keeping the scene id, and clears the draft", async () => {
    const edited = { ...JSON.parse(logic().values.sceneJSON), id: "someone-else", name: "Renamed" };
    logic().actions.setEditedSceneJSON(JSON.stringify(edited));
    await logic().asyncActions.saveChanges();
    expect(sceneInForm().name).toBe("Renamed");
    expect(sceneInForm().id).toBe(sceneId);
    expect(embedFrameLogic({ frameId }).values.frameForm.scenes).toHaveLength(1);
    expect(logic().values.editedSceneJSON).toBe(null);
    expect(logic().values.hasChanges).toBe(false);
  });

  it("gives a saved node without a position somewhere to be", async () => {
    const edited = JSON.parse(logic().values.sceneJSON) as FrameScene;
    edited.nodes = [...edited.nodes, { id: "code", type: "code", data: { code: "1 + 1" } } as FrameScene["nodes"][number]];
    logic().actions.setEditedSceneJSON(JSON.stringify(edited));
    await logic().asyncActions.saveChanges();
    const saved = sceneInForm().nodes.find((node) => node.id === "code");
    expect(saved).toBeDefined();
    expect(Number.isFinite(saved?.position?.x)).toBe(true);
    expect(Number.isFinite(saved?.position?.y)).toBe(true);
  });

  it("leaves the scene untouched on a JSON array or invalid JSON", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const before = sceneInForm();
    logic().actions.setEditedSceneJSON("[1, 2]");
    await logic().asyncActions.saveChanges();
    expect(sceneInForm()).toBe(before);
    logic().actions.setEditedSceneJSON("{ nope");
    await logic().asyncActions.saveChanges();
    expect(sceneInForm()).toBe(before);
    expect(error).toHaveBeenCalledTimes(2);
    expect(logic().values.editedSceneJSON).toBe("{ nope");
  });
});

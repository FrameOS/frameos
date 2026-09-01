// @vitest-environment jsdom
//
// The embedded editor (frameos-editor, mounted on every scene-store page)
// swaps scenes/frame/frameLogic for src/embed/embedFrameLogic through an
// esbuild alias (frontend/build.mjs). Every other editor logic still
// `connect`s to "frameLogic" by name — and kea throws at build time when a
// requested action or value is missing, which takes the whole editor down
// with it. That is how PR #418 broke https://scenes.frameos.net/s/<slug>:
// diagramLogic gained `convertSceneToInterpreted` / `convertingSceneId` on
// the real frameLogic, the shim never got them, and the page died with
//   [KEA] Logic "…diagramLogic.1/analog-clock-face", connecting to action
//   "convertSceneToInterpreted" returns 'undefined'
//
// This test applies the same alias with vi.mock and builds each logic the
// embedded editor mounts against the shim. A new connection on frameLogic
// that the shim lacks fails here instead of in production.

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
// editAppLogic imports monaco-editor (aliased to src/test/stubs in
// vitest.config.ts: the package has no node entry point).

import { embedFrameLogic } from "../../../../../../frontend/src/embed/embedFrameLogic";
import { frameLogic } from "../../../../../../frontend/src/scenes/frame/frameLogic";
import { frameEditorsLogic } from "../../../../../../frontend/src/scenes/frame/frameEditorsLogic";
import { appsLogic } from "../../../../../../frontend/src/scenes/frame/panels/Apps/appsLogic";
import { appNodeLogic } from "../../../../../../frontend/src/scenes/frame/panels/Diagram/appNodeLogic";
import { diagramLogic } from "../../../../../../frontend/src/scenes/frame/panels/Diagram/diagramLogic";
import { newNodePickerLogic } from "../../../../../../frontend/src/scenes/frame/panels/Diagram/newNodePickerLogic";
import { editAppLogic } from "../../../../../../frontend/src/scenes/frame/panels/EditApp/editAppLogic";
import { eventsLogic } from "../../../../../../frontend/src/scenes/frame/panels/Events/eventsLogic";
import { sceneJSONLogic } from "../../../../../../frontend/src/scenes/frame/panels/SceneJSON/sceneJSONLogic";
import { sceneStateLogic } from "../../../../../../frontend/src/scenes/frame/panels/SceneState/sceneStateLogic";
import { controlLogic } from "../../../../../../frontend/src/scenes/frame/panels/Scenes/controlLogic";
import { livePreviewLogic } from "../../../../../../frontend/src/scenes/frame/panels/Scenes/livePreviewLogic";
import { sceneSettingsLogic } from "../../../../../../frontend/src/scenes/frame/panels/Scenes/sceneSettingsLogic";
import { scenesLogic } from "../../../../../../frontend/src/scenes/frame/panels/Scenes/scenesLogic";
import { workspaceLogic } from "../../../../../../frontend/src/scenes/workspace/workspaceLogic";

const frameId = 1 as unknown as FrameType["id"];
const sceneId = "analog-clock-face";
const nodeId = "clock";

const scene = {
  id: sceneId,
  name: "Analog clock face",
  nodes: [
    {
      id: nodeId,
      type: "app",
      position: { x: 0, y: 0 },
      data: { keyword: "render/text", config: {} },
    },
  ],
  edges: [],
  fields: [],
  settings: { execution: "interpreted" },
} as unknown as FrameScene;

type EmbedTestWindow = Window & {
  FRAMEOS_APP_CONFIG?: { cloudMode: boolean };
  FRAMEOS_EMBEDDED_NO_BACKEND?: boolean;
};
const testWindow = window as EmbedTestWindow;
const fetchMock = vi.fn<typeof fetch>();
const alertMock = vi.fn();

// The logics the embedded editor mounts (frontend/src/embed/EmbeddedEditor.tsx
// and the panels it renders), with the props each is keyed on.
const editorLogics: Array<[string, () => { mount: () => () => void }]> = [
  ["frameEditorsLogic", () => frameEditorsLogic({ frameId })],
  ["workspaceLogic", () => workspaceLogic({ frameId })],
  ["scenesLogic", () => scenesLogic({ frameId })],
  ["appsLogic", () => appsLogic({ frameId })],
  ["controlLogic", () => controlLogic({ frameId })],
  ["livePreviewLogic", () => livePreviewLogic({ frameId })],
  ["diagramLogic", () => diagramLogic({ frameId, sceneId })],
  ["newNodePickerLogic", () => newNodePickerLogic({ frameId, sceneId })],
  ["appNodeLogic", () => appNodeLogic({ frameId, sceneId, nodeId })],
  ["editAppLogic", () => editAppLogic({ frameId, sceneId, nodeId })],
  ["eventsLogic", () => eventsLogic({ frameId, sceneId })],
  ["sceneJSONLogic", () => sceneJSONLogic({ frameId, sceneId })],
  ["sceneStateLogic", () => sceneStateLogic({ frameId, sceneId })],
  ["sceneSettingsLogic", () => sceneSettingsLogic({ frameId, sceneId })],
];

beforeEach(() => {
  testWindow.FRAMEOS_EMBEDDED_NO_BACKEND = true;
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response("null", { status: 404 }));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("alert", alertMock);
  alertMock.mockReset();
  initKea({ memoryRouter: true });
  embedFrameLogic({ frameId }).mount();
  embedFrameLogic({ frameId }).actions.initEmbedFrame({
    id: frameId,
    name: "Embedded",
    scenes: [scene],
    width: 800,
    height: 480,
  } as Partial<FrameType>);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete testWindow.FRAMEOS_EMBEDDED_NO_BACKEND;
});

describe("the embedded editor's frameLogic shim", () => {
  it("is what the editor logics see as frameLogic", () => {
    expect(frameLogic).toBe(embedFrameLogic);
  });

  it.each(editorLogics)("satisfies every connection %s makes to frameLogic", (_name, build) => {
    // kea resolves `connect` at build time and throws
    //   [KEA] Logic "…", connecting to action "…" returns 'undefined'
    // for anything the shim does not provide.
    const unmount = build().mount();
    unmount();
  });

  it("converts a scene through the host page's converter, in place and unsaved", async () => {
    const converted = {
      ...scene,
      name: "Analog clock face (converted)",
      settings: { execution: "interpreted" },
    } as FrameScene;
    fetchMock.mockResolvedValueOnce(
      Response.json({
        ok: true,
        scene: converted,
        reports: [
          {
            sceneId,
            sceneName: scene.name,
            executionBefore: "compiled",
            executionAfter: "interpreted",
            items: [{ kind: "code", status: "converted", nodeId: "n1" }],
            needsModel: [],
            needsManualPort: [],
            modelCalls: 0,
          },
        ],
      }),
    );

    const logic = embedFrameLogic({ frameId });
    const unmountDiagram = diagramLogic({ frameId, sceneId }).mount();
    diagramLogic({ frameId, sceneId }).actions.convertSceneToInterpreted(sceneId);
    expect(logic.values.convertingSceneId).toBe(sceneId);

    await vi.waitFor(() => expect(logic.values.convertingSceneId).toBeNull());

    // Not the embed's apiFetch (that answers 404 for everything): the
    // converter lives on the host page's own origin.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0];
    expect(call).toBeDefined();
    const [url, init] = call!;
    expect(url).toBe("/api/scenes/convert");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ scene });

    expect(logic.values.frameForm.scenes?.[0]?.name).toBe("Analog clock face (converted)");
    expect(alertMock).toHaveBeenCalledTimes(1);
    expect(String(alertMock.mock.calls[0]?.[0])).toContain("1 code node ported to JavaScript");
    unmountDiagram();
  });

  it("reports a converter failure without touching the scene", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ error: "rate_limited" }, { status: 429 }));
    const logic = embedFrameLogic({ frameId });
    logic.actions.convertSceneToInterpreted(sceneId);
    await vi.waitFor(() => expect(logic.values.convertingSceneId).toBeNull());
    expect(logic.values.frameForm.scenes?.[0]?.name).toBe("Analog clock face");
    expect(String(alertMock.mock.calls[0]?.[0])).toContain("Too many conversions");
  });
});

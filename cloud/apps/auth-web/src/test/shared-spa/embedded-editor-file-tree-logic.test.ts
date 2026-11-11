// @vitest-environment jsdom
//
// The embedded editor's file tree selection (sceneFileTreeLogic): how it
// follows the diagram — "Edit app" on a node opens the app's folder when the
// scene carries its source, a modal for a built-in app — and hands the
// keyboard back to the diagram shown.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initKea } from "../../../../../../frontend/src/initKea";
import type { FrameScene, FrameType } from "../../../../../../frontend/src/types";

vi.mock("../../../../../../frontend/src/scenes/frame/frameLogic", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../../../../frontend/src/scenes/frame/frameLogic")>();
  const { embedFrameLogic } = await import("../../../../../../frontend/src/embed/embedFrameLogic");
  return { ...actual, frameLogic: embedFrameLogic };
});
vi.mock("../../../../../../frontend/src/scenes/frame/panels/Logs/logsLogic", async () => {
  return await import("../../../../../../frontend/src/embed/logsLogicShim");
});

import { embedFrameLogic } from "../../../../../../frontend/src/embed/embedFrameLogic";
import { appTreeKey, sceneTreeKey } from "../../../../../../frontend/src/embed/sceneFiles";
import { sceneFileTreeLogic } from "../../../../../../frontend/src/embed/sceneFileTreeLogic";
import { frameEditorsLogic } from "../../../../../../frontend/src/scenes/frame/frameEditorsLogic";

const frameId = 1 as unknown as FrameType["id"];

function appNode(id: string, data: Record<string, unknown>) {
  return { id, type: "app", position: { x: 0, y: 0 }, data: { config: {}, ...data } };
}

const clock = {
  id: "clock",
  name: "Clock",
  nodes: [
    { id: "render", type: "event", position: { x: 0, y: 0 }, data: { keyword: "render" } },
    appNode("face", { keyword: "face", name: "Clock face" }),
    appNode("text1", { keyword: "render/text" }),
    appNode("text2", { keyword: "render/text" }),
    appNode("inline", { keyword: "inline", sources: { "app.ts": "", "config.json": "{}" } }),
    appNode("shared", { keyword: "weatherApp" }),
  ],
  edges: [],
  apps: {
    face: { name: "Face", sources: { "app.tsx": "" } },
    weatherApp: { name: "Weather", sources: {} },
  },
  settings: { execution: "interpreted" },
} as unknown as FrameScene;

const photos = {
  id: "photos",
  name: "  ",
  nodes: [appNode("album", { keyword: "repo/apps/image/photoAlbum", sources: { "app.ts": "" } })],
  edges: [],
  settings: { execution: "interpreted" },
} as unknown as FrameScene;

describe("sceneFileTreeLogic", () => {
  beforeEach(() => {
    (window as Window & { FRAMEOS_EMBEDDED_NO_BACKEND?: boolean }).FRAMEOS_EMBEDDED_NO_BACKEND =
      true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("null", { status: 404 })),
    );
    initKea({ memoryRouter: true });
    embedFrameLogic({ frameId }).mount();
    embedFrameLogic({ frameId }).actions.initEmbedFrame({
      id: frameId,
      name: "Embedded",
      scenes: [clock, photos],
      width: 800,
      height: 480,
    } as Partial<FrameType>);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete (window as Window & { FRAMEOS_EMBEDDED_NO_BACKEND?: boolean })
      .FRAMEOS_EMBEDDED_NO_BACKEND;
  });

  it("opens on the diagram with every folder expanded, app folders too", () => {
    const logic = sceneFileTreeLogic({ frameId });
    const unmount = logic.mount();
    expect(logic.values.shownSelection).toEqual({ kind: "diagram" });
    expect(logic.values.isExpanded(sceneTreeKey("clock"))).toBe(true);
    expect(logic.values.isExpanded(appTreeKey("clock", "face"))).toBe(true);
    logic.actions.toggleExpanded(sceneTreeKey("clock"));
    expect(logic.values.isExpanded(sceneTreeKey("clock"))).toBe(false);
    logic.actions.toggleExpanded(appTreeKey("clock", "face"));
    expect(logic.values.isExpanded(appTreeKey("clock", "face"))).toBe(false);
    unmount();
  });

  it("opens on template.json when the host asks, again after a remount", () => {
    const first = sceneFileTreeLogic({ frameId, initialFile: "template" }).mount();
    expect(sceneFileTreeLogic({ frameId }).values.shownSelection).toEqual({ kind: "template" });
    sceneFileTreeLogic({ frameId }).actions.showDiagram("clock");
    first();
    // StrictMode's (or a host's) remount starts from the prop again.
    const second = sceneFileTreeLogic({ frameId, initialFile: "template" }).mount();
    expect(sceneFileTreeLogic({ frameId }).values.shownSelection).toEqual({ kind: "template" });
    second();
  });

  it("opens a node's app in the tree, not in a modal, and gives the diagram back its keys", () => {
    const logic = sceneFileTreeLogic({ frameId });
    const unmount = logic.mount();
    const editors = frameEditorsLogic({ frameId });

    // The diagram's "Edit app" (AppNode → openAppModal → editApp).
    logic.actions.toggleExpanded(sceneTreeKey("photos"));
    editors.actions.openAppModal("photos", "album", photos.nodes[0]!.data as never);
    expect(logic.values.shownSelection).toEqual({
      kind: "app",
      sceneId: "photos",
      nodeId: "album",
    });
    // Its scene and its folder open, so the file is in view.
    expect(logic.values.isExpanded(sceneTreeKey("photos"))).toBe(true);
    expect(logic.values.isExpanded(appTreeKey("photos", "album"))).toBe(true);
    expect(editors.values.activeEditor?.kind).toBe("editApp");

    // Back to the diagram: it is the active editor again, so its global
    // shortcuts (diagramLogic's isVisibleDiagram) work there.
    logic.actions.showDiagram("photos");
    expect(logic.values.shownSelection).toEqual({ kind: "diagram" });
    expect(editors.values.activeEditor).toMatchObject({ kind: "diagram", sceneId: "photos" });

    // Another scene shown while the diagram is: it follows.
    logic.actions.syncScene("clock");
    expect(editors.values.activeEditor).toMatchObject({ kind: "diagram", sceneId: "clock" });
    // …but not while an app or the template is open.
    logic.actions.selectTemplate();
    logic.actions.syncScene("photos");
    expect(editors.values.activeEditor).toMatchObject({ kind: "diagram", sceneId: "clock" });
    unmount();
  });

  it("shows a built-in app in a modal, leaving the tree's selection alone", () => {
    const logic = sceneFileTreeLogic({ frameId });
    const unmount = logic.mount();
    const editors = frameEditorsLogic({ frameId });
    logic.actions.showDiagram("clock");

    editors.actions.openAppModal("clock", "text1", clock.nodes[2]!.data as never);
    expect(logic.values.shownSelection).toEqual({ kind: "diagram" });
    // A built-in app has no folder in the tree, so none was opened for it.
    expect(logic.values.collapsed[appTreeKey("clock", "text1")]).toBeUndefined();
    expect(logic.values.builtinAppEditor).toMatchObject({
      kind: "editApp",
      sceneId: "clock",
      nodeId: "text1",
    });
    // The modal has the keyboard while it is open…
    expect(editors.values.activeEditor).toMatchObject({ kind: "editApp", nodeId: "text1" });

    // …and closing it gives it back to the diagram shown.
    logic.actions.closeBuiltinApp("clock", "text1");
    expect(logic.values.builtinAppEditor).toBeNull();
    expect(editors.values.openEditors.some((editor) => editor.nodeId === "text1")).toBe(false);
    expect(editors.values.activeEditor).toMatchObject({ kind: "diagram", sceneId: "clock" });
    unmount();
  });

  it("opening an app file from the tree makes that app the active editor", () => {
    const logic = sceneFileTreeLogic({ frameId });
    const unmount = logic.mount();
    logic.actions.openAppFile("clock", "inline", "config.json");
    expect(logic.values.shownSelection).toEqual({
      kind: "app",
      sceneId: "clock",
      nodeId: "inline",
    });
    expect(frameEditorsLogic({ frameId }).values.activeEditor).toMatchObject({
      kind: "editApp",
      sceneId: "clock",
      nodeId: "inline",
    });
    unmount();
  });

  it("keeps a file asked for until its app's folder has shown it", () => {
    const logic = sceneFileTreeLogic({ frameId });
    const unmount = logic.mount();
    // Before the folder has loaded its files (a host's initialAppFile on the
    // first render), the file waits; selecting its own app keeps it.
    logic.actions.openAppFile("clock", "face", "app.tsx");
    expect(logic.values.pendingAppFile).toEqual({ sceneId: "clock", nodeId: "face", file: "app.tsx" });
    expect(logic.values.shownSelection).toEqual({ kind: "app", sceneId: "clock", nodeId: "face" });
    logic.actions.appFileOpened();
    expect(logic.values.pendingAppFile).toBeNull();

    // Anything else picked meanwhile drops it: the visitor has moved on.
    logic.actions.openAppFile("clock", "face", "app.tsx");
    logic.actions.selectApp("clock", "inline");
    expect(logic.values.pendingAppFile).toBeNull();
    logic.actions.openAppFile("clock", "face", "app.tsx");
    logic.actions.showDiagram("clock");
    expect(logic.values.pendingAppFile).toBeNull();
    unmount();
  });

  it("drops a template source error when the view changes", () => {
    const logic = sceneFileTreeLogic({ frameId });
    const unmount = logic.mount();
    logic.actions.setTemplateSourceView(true);
    logic.actions.setTemplateSourceError("Unexpected end of JSON input");
    expect(logic.values.templateSourceError).toBe("Unexpected end of JSON input");
    logic.actions.setTemplateSourceView(false);
    expect(logic.values.templateSourceError).toBeNull();
    unmount();
  });
});

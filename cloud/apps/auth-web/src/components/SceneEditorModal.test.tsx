// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useEffect, useRef, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { singlePanelFor } from "../lib/scene-views";
import {
  PANELS_STORAGE_KEY,
  SceneEditorModal,
  editorViewportForWidthChange,
  panelColumnTemplate,
} from "./SceneEditorModal";

// The embedded editor is kea + reactflow + Monaco: stood in for by a stub
// that shows the props this workspace is responsible for, lets a test push
// an edit through onScenesChanged, switch scene tabs, and answers the host's
// rename through apiRef the way the real editor does (an echo of the
// renamed scenes through onScenesChanged).
type StubEditorApi = {
  renameScene: (sceneId: string, name: string) => void;
  panBy: (dx: number, dy: number) => void;
  fitView: () => void;
};
type StubEditorProps = {
  scenes: unknown[];
  showPreviewButton?: boolean | undefined;
  onScenesChanged?: ((scenes: unknown[]) => void) | undefined;
  onSelectedSceneChanged?: ((sceneId: string | null) => void) | undefined;
  apiRef?: { current: StubEditorApi | null } | undefined;
};
const renameCalls: Array<[string, string]> = [];
const panCalls: Array<[number, number]> = [];
let fitCalls = 0;
function StubEditor(props: StubEditorProps) {
  const currentRef = useRef(props.scenes);
  useEffect(() => {
    currentRef.current = props.scenes;
  }, [props.scenes]);
  const emit = (scenes: unknown[]) => {
    currentRef.current = scenes;
    props.onScenesChanged?.(scenes);
  };
  useEffect(() => {
    const apiRef = props.apiRef;
    if (!apiRef) {
      return;
    }
    apiRef.current = {
      fitView: () => {
        fitCalls += 1;
      },
      panBy: (dx, dy) => {
        panCalls.push([dx, dy]);
      },
      renameScene: (sceneId, name) => {
        renameCalls.push([sceneId, name]);
        emit(
          currentRef.current.map((scene) => {
            const entry = scene as { id: string };
            return entry.id === sceneId ? { ...entry, name } : entry;
          }),
        );
      },
    };
    return () => {
      apiRef.current = null;
    };
  });
  return (
    <div data-scenes={JSON.stringify(props.scenes)} data-show-preview={String(props.showPreviewButton)} data-testid="editor">
      <button onClick={() => emit([{ id: "s1", name: "Edited" }])} type="button">
        emit edit
      </button>
      <button
        // What the real editor does right after init: the same scenes,
        // normalised (keys reordered, defaults filled in).
        onClick={() => emit([{ edges: [], id: "s1", name: "Loaded", nodes: [], default: true }])}
        type="button"
      >
        emit echo
      </button>
      <button onClick={() => props.onSelectedSceneChanged?.("s2")} type="button">
        select s2
      </button>
    </div>
  );
}
vi.mock("next/dynamic", () => ({ default: () => StubEditor }));

type PanelProps = {
  scenes: readonly unknown[];
  editorSceneId?: string | null | undefined;
};
vi.mock("./SceneLivePreview", () => ({
  SceneLivePreviewPanel: (props: PanelProps) => (
    <div
      data-editor-scene={props.editorSceneId ?? ""}
      data-props={JSON.stringify(Object.keys(props).sort())}
      data-scenes={JSON.stringify(props.scenes)}
      data-testid="preview-panel"
    />
  ),
}));
vi.mock("./SceneAiPanel", () => ({
  SceneAiPanel: (props: { initialPrompt?: string | undefined }) => (
    <div data-prompt={props.initialPrompt ?? ""} data-testid="ai-panel" />
  ),
}));
type InfoProps = {
  heading?: ReactNode;
  scene: { name: string };
};
vi.mock("./SceneInfoPanel", () => ({
  SceneInfoPanel: (props: InfoProps) => (
    <div data-scene={props.scene.name} data-testid="info-panel">
      <div data-testid="info-heading">{props.heading}</div>
    </div>
  ),
}));
type InstallDialogProps = {
  installVersion: number | null;
  signedIn: boolean;
  returnTo: string;
  pageUrl: string;
  onClose: () => void;
};
vi.mock("./SceneInstallDialog", () => ({
  SceneInstallDialog: (props: InstallDialogProps) => (
    <div
      data-page-url={props.pageUrl}
      data-return-to={props.returnTo}
      data-signed-in={String(props.signedIn)}
      data-testid="install-dialog"
      data-version={props.installVersion ?? ""}
    >
      <button onClick={props.onClose} type="button">
        close install
      </button>
    </div>
  ),
}));
const { pushMock, refreshMock } = vi.hoisted(() => ({ pushMock: vi.fn(), refreshMock: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, refresh: refreshMock }),
}));

const loadedScenes = [{ default: true, id: "s1", name: "Loaded" }];
const twoScenes = [...loadedScenes, { id: "s2", name: "Second" }];
/** What scenes.json serves for ?version=1 (the latest is `scenesJson`). */
const v1Scenes = [{ default: true, id: "s1", name: "Loaded v1" }];
let scenesJson: unknown[] = loadedScenes;
const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.includes("/scenes.json")) {
    return Response.json(url.includes("version=1") ? v1Scenes : scenesJson);
  }
  if (url.endsWith("/content") && init?.method === "POST") {
    return Response.json({ ok: true, scene: { version: 3 } });
  }
  throw new Error(`Unexpected fetch: ${url}`);
});

function postedContent() {
  const call = fetchMock.mock.calls.find(([input]) => String(input).endsWith("/content"));
  return call ? (JSON.parse(String(call[1]?.body)) as { scenes: { name: string }[] }) : null;
}

function scenesJsonUrls() {
  return fetchMock.mock.calls.map(([input]) => String(input)).filter((url) => url.includes("/scenes.json"));
}

function versionSelect() {
  return screen.getByRole("combobox", { name: "Version" }) as HTMLSelectElement;
}

function versionOptions() {
  return Array.from(versionSelect().options).map((option) => option.textContent);
}

function renameInput() {
  return screen.getByRole("textbox", { name: "Scene name" }) as HTMLInputElement;
}

const versions = [
  { createdAt: "2026-08-10T10:00:00.000Z", version: 1, yankedAt: null },
  { createdAt: "2026-08-24T10:00:00.000Z", version: 2, yankedAt: null },
];

// What the page hands the workspace for its Info panel (the panel itself is
// stubbed above; only the plumbing is under test here).
const info = {
  framesUrl: "https://cloud.frameos.net/frames/",
  imageIds: [],
  installableFrames: null,
  isAdmin: false,
  isOwner: true,
  pageUrl: "https://scenes.frameos.net/s/clock",
  scene: {
    accountId: "acc-1",
    category: null,
    description: null,
    downloadCount: 0,
    frameosVersion: null,
    hasPreview: true,
    id: "scene-1",
    latestVersion: 2,
    name: "Clock",
    publisher: "Marius",
    pulledReason: null,
    riskFlags: [],
    slug: "clock",
    status: "active",
    tags: [],
    updatedAt: "2026-08-24T10:00:00.000Z",
    visibility: "public",
  },
  signedIn: true,
  versions: versions.map((version) => ({
    ...version,
    frameosVersion: null,
    sha256: "0123456789abcdef0123456789abcdef",
    sizeBytes: 1024,
  })),
};

type ToggleName = "Info" | "Editor" | "AI" | "Preview";

function panelToggle(name: ToggleName) {
  return screen.getByRole("button", { name }) as HTMLButtonElement;
}

function pressed(): Record<ToggleName, boolean | null> {
  const read = (name: ToggleName) => {
    const button = screen.queryByRole("button", { name });
    return button ? button.getAttribute("aria-pressed") === "true" : null;
  };
  return { AI: read("AI"), Editor: read("Editor"), Info: read("Info"), Preview: read("Preview") };
}

function toggleOrder() {
  return Array.from(screen.getByRole("group", { name: "Panels" }).querySelectorAll("button")).map(
    (button) => button.textContent,
  );
}

function editorCell() {
  return document.querySelector(".editor-modal__editor") as HTMLElement;
}

function backButton() {
  return screen.getByRole("button", { name: "Back" });
}

function storedPanels() {
  return JSON.parse(window.localStorage.getItem(PANELS_STORAGE_KEY) ?? "null");
}

function remember(panels: Record<string, boolean>) {
  window.localStorage.setItem(PANELS_STORAGE_KEY, JSON.stringify(panels));
}

function setReferrer(value: string) {
  Object.defineProperty(document, "referrer", { configurable: true, value });
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  window.localStorage.clear();
  window.history.replaceState(null, "", "/s/clock");
  setReferrer("");
  scenesJson = loadedScenes;
  renameCalls.length = 0;
  panCalls.length = 0;
  fitCalls = 0;
  pushMock.mockClear();
  refreshMock.mockClear();
});

afterEach(() => {
  cleanup();
  fetchMock.mockClear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("SceneEditorModal landing", () => {
  it("lands on Info + Editor + Preview with nothing remembered and no hash", async () => {
    render(<SceneEditorModal info={info} sceneId="scene-1" versions={versions} />);
    expect(toggleOrder()).toEqual(["Info", "Editor", "AI", "Preview"]);
    expect(pressed()).toEqual({ AI: false, Editor: true, Info: true, Preview: true });
    expect(screen.getByTestId("info-panel")).toBeTruthy();
    expect(screen.queryByTestId("ai-panel")).toBeNull();
    // The preview mounts once scenes.json is in, on the loaded scenes.
    const panel = await screen.findByTestId("preview-panel");
    expect(panel.dataset.scenes).toBe(JSON.stringify(loadedScenes));
    // The panel runs the editor's scenes, nothing else: no source plumbing.
    expect(JSON.parse(panel.dataset.props!)).toEqual([
      "canSaveToGallery",
      "editorSceneId",
      "height",
      "sceneId",
      "scenes",
      "width",
    ]);
    // The editor mounts with the scenes, in its own column.
    await screen.findByTestId("editor");
    expect(editorCell().hidden).toBe(false);
    // Landing writes neither the URL nor the memory.
    expect(window.location.hash).toBe("");
    expect(storedPanels()).toBeNull();
  });

  it("follows the remembered set, reading a pre-Editor-toggle memory as editor on", async () => {
    remember({ ai: true, preview: false });
    const { unmount } = render(<SceneEditorModal info={info} sceneId="scene-1" />);
    expect(pressed()).toEqual({ AI: true, Editor: true, Info: false, Preview: false });
    await screen.findByTestId("editor");
    expect(screen.getByTestId("editor").dataset.showPreview).toBe("false");
    expect(screen.getByTestId("ai-panel")).toBeTruthy();
    unmount();

    remember({ ai: false, editor: false, info: true, preview: false });
    render(<SceneEditorModal info={info} sceneId="scene-1" />);
    expect(pressed()).toEqual({ AI: false, Editor: false, Info: true, Preview: false });
    // The only open panel cannot be closed.
    expect(panelToggle("Info").disabled).toBe(true);
    expect(panelToggle("Editor").disabled).toBe(false);
  });

  it("honours every hash spelling, bringing old ones onto today's", async () => {
    const cases: Array<[string, Record<ToggleName, boolean>, string]> = [
      ["#scene-editor", { AI: false, Editor: true, Info: false, Preview: false }, "#scene-editor"],
      ["#scene-editor-preview", { AI: false, Editor: true, Info: false, Preview: true }, "#scene-editor-preview"],
      ["#scene-editor-ai", { AI: true, Editor: true, Info: false, Preview: false }, "#scene-editor-ai"],
      [
        "#scene-editor-info-preview-ai",
        { AI: true, Editor: true, Info: true, Preview: true },
        "#scene-editor-info-preview-ai",
      ],
      ["#live-preview", { AI: false, Editor: false, Info: false, Preview: true }, "#scene-preview"],
      ["#scene-info-preview", { AI: false, Editor: false, Info: true, Preview: true }, "#scene-info-preview"],
      ["#scene-ai-info", { AI: true, Editor: false, Info: true, Preview: false }, "#scene-info-ai"],
    ];
    for (const [hash, expected, canonical] of cases) {
      window.history.replaceState(null, "", `/s/clock${hash}`);
      const { unmount } = render(<SceneEditorModal info={info} sceneId="scene-1" />);
      expect(pressed()).toEqual(expected);
      expect(window.location.hash).toBe(canonical);
      unmount();
      window.localStorage.clear();
    }
  });

  it("follows the hash live (back/forward, a hand-edited URL)", async () => {
    render(<SceneEditorModal info={info} sceneId="scene-1" />);
    expect(pressed()).toEqual({ AI: false, Editor: true, Info: true, Preview: true });
    window.history.replaceState(null, "", "/s/clock#scene-editor-ai");
    act(() => window.dispatchEvent(new Event("hashchange")));
    expect(pressed()).toEqual({ AI: true, Editor: true, Info: false, Preview: false });
    window.history.replaceState(null, "", "/s/clock");
    act(() => window.dispatchEvent(new Event("popstate")));
    // No hash: back to what is remembered (nothing) → the default.
    expect(pressed()).toEqual({ AI: false, Editor: true, Info: true, Preview: true });
  });

  it("drops the panels a scene cannot show", async () => {
    window.history.replaceState(null, "", "/s/clock#scene-info-preview");
    const { unmount } = render(<SceneEditorModal sceneId="scene-1" />);
    expect(toggleOrder()).toEqual(["Editor", "AI", "Preview"]);
    expect(pressed()).toEqual({ AI: false, Editor: false, Info: null, Preview: true });
    expect(window.location.hash).toBe("#scene-preview");
    expect(screen.queryByTestId("info-panel")).toBeNull();
    unmount();

    window.history.replaceState(null, "", "/s/clock");
    render(<SceneEditorModal canPreview={false} canRemix={false} sceneId="scene-1" />);
    expect(toggleOrder()).toEqual(["Editor"]);
    // Nothing of the default is available: the editor stands in.
    expect(pressed()).toEqual({ AI: null, Editor: true, Info: null, Preview: null });
    expect(window.location.hash).toBe("");
  });

  it("opens the AI panel with the prompt from ?ai=", async () => {
    window.history.replaceState(null, "", "/s/clock?ai=make+it+blue");
    render(<SceneEditorModal info={info} sceneId="scene-1" />);
    expect(pressed()).toEqual({ AI: true, Editor: true, Info: true, Preview: true });
    expect(screen.getByTestId("ai-panel").dataset.prompt).toBe("make it blue");
  });
});

describe("SceneEditorModal panel toggles", () => {
  it("toggles each panel, keeps the hash and the memory truthful, in layout order", async () => {
    remember({ ai: false, editor: true, info: false, preview: false });
    render(<SceneEditorModal info={info} sceneId="scene-1" />);
    await screen.findByTestId("editor");
    expect(screen.queryByTestId("preview-panel")).toBeNull();
    expect(screen.queryByTestId("ai-panel")).toBeNull();

    fireEvent.click(panelToggle("Info"));
    expect(window.location.hash).toBe("#scene-editor-info");
    expect(storedPanels()).toEqual({ ai: false, editor: true, info: true, preview: false });
    expect(screen.getByRole("complementary", { name: "Scene info" })).toBeTruthy();
    expect(screen.getByRole("separator", { name: "Resize the Info panel" })).toBeTruthy();

    fireEvent.click(panelToggle("AI"));
    fireEvent.click(panelToggle("Preview"));
    expect(window.location.hash).toBe("#scene-editor-info-preview-ai");
    expect(storedPanels()).toEqual({ ai: true, editor: true, info: true, preview: true });
    await screen.findByTestId("preview-panel");
    // Column order: Info, Editor, AI, Preview.
    const order = [
      screen.getByTestId("info-panel"),
      screen.getByTestId("editor"),
      screen.getByTestId("ai-panel"),
      screen.getByTestId("preview-panel"),
    ];
    for (let index = 1; index < order.length; index += 1) {
      expect(
        order[index - 1]!.compareDocumentPosition(order[index]!) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
    expect(screen.getByRole("separator", { name: "Resize the AI panel" })).toBeTruthy();
    expect(screen.getByRole("separator", { name: "Resize the Preview panel" })).toBeTruthy();

    fireEvent.click(panelToggle("Editor"));
    expect(window.location.hash).toBe("#scene-info-preview-ai");
    expect(storedPanels()).toEqual({ ai: true, editor: false, info: true, preview: true });
    // Hidden, not unmounted.
    expect(editorCell().hidden).toBe(true);
    expect(screen.getByTestId("editor")).toBeTruthy();
    // With the editor gone the leftover width is the preview's: the handles
    // now sit on Info's and AI's right edges, and drag those.
    expect(screen.getAllByRole("separator").map((handle) => handle.getAttribute("aria-label"))).toEqual([
      "Resize the Info panel",
      "Resize the AI panel",
    ]);

    fireEvent.click(panelToggle("Info"));
    fireEvent.click(panelToggle("AI"));
    expect(window.location.hash).toBe("#scene-preview");
    expect(storedPanels()).toEqual({ ai: false, editor: false, info: false, preview: true });
    // Toggling replaces the URL in place: no history entries pile up.
    expect(window.history.state).toBeNull();
  });

  it("keeps the last open panel open", async () => {
    remember({ ai: false, editor: true, info: false, preview: false });
    render(<SceneEditorModal info={info} sceneId="scene-1" />);
    const editorToggle = panelToggle("Editor");
    expect(editorToggle.disabled).toBe(true);
    expect(editorToggle.getAttribute("title")).toBe("At least one panel stays open");
    fireEvent.click(editorToggle);
    expect(pressed().Editor).toBe(true);
    expect(window.location.hash).toBe("");
    // Opening a second one frees it.
    fireEvent.click(panelToggle("Preview"));
    expect(panelToggle("Editor").disabled).toBe(false);
    expect(panelToggle("Preview").disabled).toBe(false);
  });

  it("keeps unsaved edits while the Editor is hidden", async () => {
    remember({ ai: false, editor: true, info: false, preview: true });
    render(<SceneEditorModal canSave info={info} sceneId="scene-1" />);
    await screen.findByTestId("editor");
    fireEvent.click(screen.getByRole("button", { name: "emit echo" }));
    fireEvent.click(screen.getByRole("button", { name: "emit edit" }));
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    expect(screen.getByTestId("preview-panel").dataset.scenes).toBe(
      JSON.stringify([{ id: "s1", name: "Edited" }]),
    );

    fireEvent.click(panelToggle("Editor"));
    expect(editorCell().hidden).toBe(true);
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    expect(screen.getByTestId("preview-panel").dataset.scenes).toBe(
      JSON.stringify([{ id: "s1", name: "Edited" }]),
    );

    fireEvent.click(panelToggle("Editor"));
    expect(editorCell().hidden).toBe(false);
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Save as new version/ })).not.toHaveProperty("disabled", true);
  });

  it("does not count the editor's normalised echo of the loaded scenes as an edit", async () => {
    remember({ ai: false, editor: true, info: false, preview: false });
    render(<SceneEditorModal canSave sceneId="scene-1" />);
    await screen.findByTestId("editor");
    expect(screen.queryByText("Unsaved changes")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "emit echo" }));
    expect(screen.queryByText("Unsaved changes")).toBeNull();
    // Repeating the same payload is still not an edit…
    fireEvent.click(screen.getByRole("button", { name: "emit echo" }));
    expect(screen.queryByText("Unsaved changes")).toBeNull();
    // …a real change is.
    fireEvent.click(screen.getByRole("button", { name: "emit edit" }));
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    // And back to the echoed baseline clears it again.
    fireEvent.click(screen.getByRole("button", { name: "emit echo" }));
    expect(screen.queryByText("Unsaved changes")).toBeNull();
  });

  it("hands the Preview panel the current scenes when it is opened after edits", async () => {
    remember({ ai: false, editor: true, info: false, preview: false });
    render(<SceneEditorModal sceneId="scene-1" />);
    await screen.findByTestId("editor");
    fireEvent.click(screen.getByRole("button", { name: "emit edit" }));

    fireEvent.click(panelToggle("Preview"));
    const panel = await screen.findByTestId("preview-panel");
    expect(panel.dataset.scenes).toBe(JSON.stringify([{ id: "s1", name: "Edited" }]));
  });

});

describe("SceneEditorModal versions", () => {
  it("lists the versions in the bar, newest first, the latest marked, and loads the one picked into the workspace", async () => {
    window.history.replaceState(null, "", "/s/clock#scene-editor-info-preview");
    render(
      <SceneEditorModal
        canSave
        downloadUrl="/api/store/scenes/scene-1/download"
        info={info}
        sceneId="scene-1"
        versions={versions}
      />,
    );
    await screen.findByTestId("editor");
    // The dropdown sits right after the panel toggles.
    const left = document.querySelector(".editor-modal__title")!;
    expect(Array.from(left.children).map((child) => child.getAttribute("aria-label"))).toEqual([
      "Back",
      "Panels",
      "Version",
    ]);
    expect(versionOptions()).toEqual(["v2 (latest)", "v1", "──────", "Manage versions…"]);
    expect(versionSelect().value).toBe("2");
    expect(scenesJsonUrls()).toEqual(["/api/store/scenes/scene-1/scenes.json"]);
    expect(screen.getByRole("link", { name: /Download \.zip/ }).getAttribute("href")).toBe(
      "/api/store/scenes/scene-1/download",
    );

    // v1: its scenes.json goes into the editor (a fresh array — the editor
    // re-initialises) and to the preview; the URL and the zip follow.
    fireEvent.change(versionSelect(), { target: { value: "1" } });
    expect(versionSelect().value).toBe("1");
    await waitFor(() => expect(screen.getByTestId("editor").dataset.scenes).toBe(JSON.stringify(v1Scenes)));
    expect(scenesJsonUrls()).toEqual([
      "/api/store/scenes/scene-1/scenes.json",
      "/api/store/scenes/scene-1/scenes.json?version=1",
    ]);
    expect(screen.getByTestId("preview-panel").dataset.scenes).toBe(JSON.stringify(v1Scenes));
    expect(screen.getByText("Loaded v1")).toBeTruthy();
    expect(`${window.location.search}${window.location.hash}`).toBe("?version=1#scene-editor-info-preview");
    expect(screen.getByRole("link", { name: /Download \.zip/ }).getAttribute("href")).toBe(
      "/api/store/scenes/scene-1/download?version=1",
    );
    // A cloud install pins it (v1 is not the latest).
    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    expect(screen.getByTestId("install-dialog").dataset.version).toBe("1");
    fireEvent.click(screen.getByRole("button", { name: "close install" }));

    // Back to the latest: no ?version=, nothing pinned.
    fireEvent.change(versionSelect(), { target: { value: "2" } });
    await waitFor(() => expect(screen.getByTestId("editor").dataset.scenes).toBe(JSON.stringify(loadedScenes)));
    expect(`${window.location.search}${window.location.hash}`).toBe("#scene-editor-info-preview");
    expect(screen.getByRole("link", { name: /Download \.zip/ }).getAttribute("href")).toBe(
      "/api/store/scenes/scene-1/download",
    );
    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    expect(screen.getByTestId("install-dialog").dataset.version).toBe("");
  });

  it("asks before a load would discard unsaved edits, and resets the unsaved state on loading", async () => {
    render(<SceneEditorModal canSave info={info} sceneId="scene-1" versions={versions} />);
    await screen.findByTestId("editor");
    fireEvent.click(screen.getByRole("button", { name: "emit echo" }));
    fireEvent.click(screen.getByRole("button", { name: "emit edit" }));
    expect(screen.getByText("Unsaved changes")).toBeTruthy();

    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.change(versionSelect(), { target: { value: "1" } });
    expect(confirm).toHaveBeenCalledWith("Discard your unsaved changes and load v1?");
    // Declined: nothing loads, the edits stay.
    expect(versionSelect().value).toBe("2");
    expect(scenesJsonUrls()).toHaveLength(1);
    expect(screen.getByText("Unsaved changes")).toBeTruthy();

    confirm.mockReturnValue(true);
    fireEvent.change(versionSelect(), { target: { value: "1" } });
    await waitFor(() => expect(screen.getByTestId("editor").dataset.scenes).toBe(JSON.stringify(v1Scenes)));
    expect(screen.queryByText("Unsaved changes")).toBeNull();
    expect((screen.getByRole("button", { name: "Save as new version" }) as HTMLButtonElement).disabled).toBe(true);
    // The editor's normalised echo of the loaded version is not an edit either.
    fireEvent.click(screen.getByRole("button", { name: "emit echo" }));
    expect(screen.queryByText("Unsaved changes")).toBeNull();
    // A clean workspace loads without asking.
    fireEvent.change(versionSelect(), { target: { value: "2" } });
    expect(confirm).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.getByTestId("editor").dataset.scenes).toBe(JSON.stringify(loadedScenes)));
  });

  it("loads the pinned version first when the page is pinned to one", async () => {
    window.history.replaceState(null, "", "/s/clock?version=1");
    render(<SceneEditorModal info={info} pinnedVersion={1} sceneId="scene-1" versions={versions} />);
    await screen.findByTestId("editor");
    expect(scenesJsonUrls()).toEqual(["/api/store/scenes/scene-1/scenes.json?version=1"]);
    expect(versionSelect().value).toBe("1");
    await waitFor(() => expect(screen.getByTestId("editor").dataset.scenes).toBe(JSON.stringify(v1Scenes)));
    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    expect(screen.getByTestId("install-dialog").dataset.version).toBe("1");
  });

  it("moves to the version a save publishes, before the page's list knows it", async () => {
    render(<SceneEditorModal canSave info={info} sceneId="scene-1" versions={versions} />);
    await screen.findByTestId("editor");
    fireEvent.click(screen.getByRole("button", { name: "emit echo" }));
    fireEvent.click(screen.getByRole("button", { name: "emit edit" }));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: /Save as new version/ }));
    await waitFor(() => expect(screen.queryByText("Unsaved changes")).toBeNull());
    expect(versionSelect().value).toBe("3");
    expect(versionOptions()).toEqual(["v3 (latest)", "v2", "v1", "──────", "Manage versions…"]);
    expect(refreshMock).toHaveBeenCalled();
  });

  it("opens the versions dialog from the dropdown's last entry, with the table and its loads", async () => {
    render(<SceneEditorModal canSave info={info} sceneId="scene-1" versions={versions} />);
    await screen.findByTestId("editor");
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.change(versionSelect(), { target: { value: "manage" } });
    // The dropdown stays on the loaded version.
    expect(versionSelect().value).toBe("2");
    const dialog = screen.getByRole("dialog", { name: "Versions of Clock" });
    expect(dialog.parentElement).toBe(document.body);
    const rows = within(dialog).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    expect(within(dialog).getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual([
      "Version",
      "Published",
      "Action",
    ]);
    expect(within(rows[0]!).getByRole("link", { name: "v2" }).getAttribute("href")).toBe("/s/clock?version=2");
    expect(within(rows[0]!).getByText("Latest")).toBeTruthy();
    expect(within(rows[0]!).getByText("In the editor")).toBeTruthy();
    expect(within(rows[0]!).getByRole("button", { name: "Unpublish" })).toBeTruthy();
    expect(within(rows[1]!).getByText("Published")).toBeTruthy();
    expect(within(rows[1]!).getByText("1.0 KB")).toBeTruthy();
    expect(within(rows[1]!).getByText("0123456789ab…").getAttribute("title")).toBe(
      "SHA-256 0123456789abcdef0123456789abcdef",
    );

    // Esc closes it; so does its ×.
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.change(versionSelect(), { target: { value: "manage" } });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();

    // A version in the table loads it and closes the dialog.
    fireEvent.change(versionSelect(), { target: { value: "manage" } });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("link", { name: "v1" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(versionSelect().value).toBe("1");
    await waitFor(() => expect(screen.getByTestId("editor").dataset.scenes).toBe(JSON.stringify(v1Scenes)));
    expect(window.location.search).toBe("?version=1");
  });

  it("offers a visitor the details, not the management, and no dropdown without versions", async () => {
    const { unmount } = render(
      <SceneEditorModal info={{ ...info, isOwner: false }} sceneId="scene-1" versions={versions} />,
    );
    expect(versionOptions()).toEqual(["v2 (latest)", "v1", "──────", "Version details…"]);
    fireEvent.change(versionSelect(), { target: { value: "manage" } });
    const dialog = screen.getByRole("dialog", { name: "Versions of Clock" });
    expect(within(dialog).getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual([
      "Version",
      "Published",
    ]);
    expect(within(dialog).queryByRole("button", { name: "Unpublish" })).toBeNull();
    await screen.findByTestId("editor");
    unmount();

    render(<SceneEditorModal sceneId="scene-1" />);
    expect(screen.queryByRole("combobox", { name: "Version" })).toBeNull();
    await screen.findByTestId("editor");
  });
});

describe("SceneEditorModal Install dialog", () => {
  it("opens from the bar for everyone, pinning the previewed version when it is not the latest", async () => {
    remember({ ai: false, editor: false, info: true, preview: true });
    window.history.replaceState(null, "", "/s/clock?share=tok#scene-info-preview");
    render(<SceneEditorModal info={info} sceneId="scene-1" versions={versions} />);
    expect(screen.queryByTestId("install-dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    let dialog = screen.getByTestId("install-dialog");
    expect(dialog.dataset.version).toBe("");
    expect(dialog.dataset.signedIn).toBe("true");
    expect(dialog.dataset.pageUrl).toBe("https://scenes.frameos.net/s/clock");
    expect(dialog.dataset.returnTo).toBe("/s/clock?share=tok#scene-info-preview");
    fireEvent.click(screen.getByRole("button", { name: "close install" }));
    expect(screen.queryByTestId("install-dialog")).toBeNull();

    // The workspace holds v1 (not the latest, v2): a cloud install pins it.
    await screen.findByTestId("preview-panel");
    fireEvent.change(versionSelect(), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    dialog = screen.getByTestId("install-dialog");
    expect(dialog.dataset.version).toBe("1");
  });

  it("is not offered without page info to install from", async () => {
    render(<SceneEditorModal sceneId="scene-1" />);
    expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  });
});

// A ResizeObserver stand-in: one callback per observed element, fired by
// the test with the width it wants the element to have.
const observers = new Map<Element, ResizeObserverCallback>();
class FakeResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(element: Element) {
    observers.set(element, this.callback);
  }
  unobserve() {}
  disconnect() {}
}
function fakeResize(element: Element, width: number) {
  act(() => observers.get(element)?.([{ contentRect: { width } } as ResizeObserverEntry], {} as ResizeObserver));
}
function frameElement() {
  return document.querySelector(".editor-modal__frame") as HTMLElement;
}

describe("SceneEditorWorkspace diagram centring", () => {
  beforeEach(() => {
    observers.clear();
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    // Fits are deferred a frame; run them right away.
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
  });

  it("fits the diagram when its column appears or jumps, pans it by half a smaller change, skips a hidden column", async () => {
    remember({ ai: false, editor: true, info: true, preview: false });
    render(<SceneEditorModal info={info} sceneId="scene-1" />);
    await screen.findByTestId("editor");
    // The column's first measure: fit to it.
    fakeResize(editorCell(), 1000);
    expect(fitCalls).toBe(1);
    expect(panCalls).toEqual([]);
    // A handle dragged: half the change, sideways.
    fakeResize(editorCell(), 900);
    expect(panCalls).toEqual([[-50, 0]]);
    // Nothing changed, nothing done.
    fakeResize(editorCell(), 900);
    expect(panCalls).toEqual([[-50, 0]]);
    expect(fitCalls).toBe(1);
    // A panel opened beside it (more than 40% lost): a fit, not a pan.
    fakeResize(editorCell(), 500);
    expect(fitCalls).toBe(2);
    expect(panCalls).toEqual([[-50, 0]]);

    // Hidden (0 wide, nothing painted): skipped; shown again, it is a
    // column that just appeared: fitted, whatever its width.
    fireEvent.click(panelToggle("Editor"));
    expect(editorCell().hidden).toBe(true);
    fakeResize(editorCell(), 0);
    expect(fitCalls).toBe(2);
    fireEvent.click(panelToggle("Editor"));
    fakeResize(editorCell(), 520);
    expect(fitCalls).toBe(3);
    expect(panCalls).toEqual([[-50, 0]]);
  });

  it("decides between fit, pan and nothing from the width change (the pure helper)", () => {
    expect(editorViewportForWidthChange(null, 640)).toEqual({ kind: "fit" });
    expect(editorViewportForWidthChange(640, 640)).toEqual({ kind: "none" });
    expect(editorViewportForWidthChange(1000, 900)).toEqual({ dx: -50, kind: "pan" });
    expect(editorViewportForWidthChange(600, 601)).toEqual({ dx: 0.5, kind: "pan" });
    // 40% of the wider of the two is the line, either way round.
    expect(editorViewportForWidthChange(1000, 600)).toEqual({ dx: -200, kind: "pan" });
    expect(editorViewportForWidthChange(1000, 599)).toEqual({ kind: "fit" });
    expect(editorViewportForWidthChange(599, 1000)).toEqual({ kind: "fit" });
    expect(editorViewportForWidthChange(142, 528)).toEqual({ kind: "fit" });
  });
});

describe("SceneEditorWorkspace column widths", () => {
  const widths = { ai: 380, editor: 640, info: 380, preview: 520 };
  const all = ["info", "editor", "ai", "preview"] as const;

  it("gives the fixed columns their widths while they fit beside the editor's floor", () => {
    // 1400 wide: the editor's floor is 30% = 420; Info + Preview fit as stored.
    expect(panelColumnTemplate(["info", "editor", "preview"], "editor", widths, 1400)).toBe(
      "380px 6px minmax(420px, 1fr) 6px 520px",
    );
    // Narrow enough that 360 beats 30%.
    expect(panelColumnTemplate(["editor", "preview"], "editor", widths, 1000)).toBe(
      "minmax(360px, 1fr) 6px 520px",
    );
    // Not measured yet: the widths as stored.
    expect(panelColumnTemplate(all, "editor", widths, null)).toBe(
      "380px 6px minmax(360px, 1fr) 6px 380px 6px 520px",
    );
  });

  it("shrinks the fixed columns uniformly, down to their minimums, when they do not", () => {
    // 1400 - 3 handles (18) - the editor's 420 leaves 962 for 1280 stored:
    // each keeps 962/1280 of its width.
    expect(panelColumnTemplate(all, "editor", widths, 1400)).toBe(
      "285px 6px minmax(420px, 1fr) 6px 285px 6px 390px",
    );
    // 1200 - 18 - 360 = 822 for 1280: Info/AI would be 244, Preview 333.
    expect(panelColumnTemplate(all, "editor", widths, 1200)).toBe(
      "244px 6px minmax(360px, 1fr) 6px 244px 6px 333px",
    );
    // 1100 - 18 - 360 = 722: even the minimums (240 + 240 + 320) overflow,
    // so they all give the same share below them.
    expect(panelColumnTemplate(all, "editor", widths, 1100)).toBe(
      "216px 6px minmax(360px, 1fr) 6px 216px 6px 288px",
    );
  });

  it("lets the Preview take the leftover width when the editor is closed", () => {
    expect(panelColumnTemplate(["info", "preview"], "preview", widths, 1400)).toBe(
      "380px 6px minmax(320px, 1fr)",
    );
    expect(panelColumnTemplate(["info", "ai", "preview"], "preview", widths, 900)).toBe(
      "284px 6px 284px 6px minmax(320px, 1fr)",
    );
  });

  it("lays the columns out from the measured frame width, following resizes", async () => {
    observers.clear();
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    remember({ ai: true, editor: true, info: true, preview: true });
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 1400 } as DOMRect);
    render(<SceneEditorModal info={info} sceneId="scene-1" />);
    await screen.findByTestId("editor");
    expect(frameElement().style.gridTemplateColumns).toBe("285px 6px minmax(420px, 1fr) 6px 285px 6px 390px");
    // The frame's own observer…
    rect.mockReturnValue({ width: 1100 } as DOMRect);
    fakeResize(frameElement(), 1100);
    expect(frameElement().style.gridTemplateColumns).toBe("216px 6px minmax(360px, 1fr) 6px 216px 6px 288px");
    // …and the window's resize (the frame spans the viewport) both re-measure.
    rect.mockReturnValue({ width: 2000 } as DOMRect);
    act(() => window.dispatchEvent(new Event("resize")));
    expect(frameElement().style.gridTemplateColumns).toBe("380px 6px minmax(600px, 1fr) 6px 380px 6px 520px");
  });
});

describe("SceneEditorModal bar", () => {
  it("offers the store zip the page links to, when it has one", async () => {
    const { unmount } = render(
      <SceneEditorModal downloadUrl="/api/store/scenes/scene-1/download?share=tok" sceneId="scene-1" />,
    );
    const link = screen.getByRole("link", { name: /Download \.zip/ });
    expect(link.getAttribute("href")).toBe("/api/store/scenes/scene-1/download?share=tok");
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    unmount();

    render(<SceneEditorModal sceneId="scene-1" />);
    expect(screen.queryByRole("link", { name: /Download \.zip/ })).toBeNull();
  });

  it("lays the bar out as Back, the panel toggles, the version, then Save / Fork / Download on the right", async () => {
    render(
      <SceneEditorModal
        canFork
        canSave
        downloadUrl="/api/store/scenes/scene-1/download"
        info={info}
        sceneId="scene-1"
        versions={versions}
      />,
    );
    const left = document.querySelector(".editor-modal__title")!;
    const label = (child: Element) => child.getAttribute("aria-label") ?? child.textContent?.trim();
    expect(Array.from(left.children).map(label)).toEqual(["Back", "Panels", "Version"]);
    const right = document.querySelector(".editor-modal__bar .button-row")!;
    expect(Array.from(right.children).map(label)).toEqual([
      "Install",
      "Save as new version",
      "Fork & save copy",
      "Download .zip",
    ]);
    expect(left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The scene's name heads the Info panel, not the bar.
    await waitFor(() => expect(screen.getByText("Loaded")).toBeTruthy());
    expect(screen.getByTestId("info-heading").contains(screen.getByText("Loaded"))).toBe(true);
    expect(left.textContent).not.toContain("Loaded");
    // Editing puts the Unsaved pill right after the version dropdown (its
    // long and its phone-length spelling; CSS shows one).
    fireEvent.click(await screen.findByRole("button", { name: "emit echo" }));
    fireEvent.click(screen.getByRole("button", { name: "emit edit" }));
    expect(Array.from(left.children).map(label)).toEqual(["Back", "Panels", "Version", "Unsaved changesUnsaved"]);
    expect(within(left.children[3] as HTMLElement).getByText("Unsaved changes")).toBeTruthy();
    expect(Array.from(right.children).map(label)).toEqual([
      "Install",
      "Save as new version",
      "Fork & save copy",
      "Download .zip",
    ]);
  });

  it("keeps the scene's name in the bar while the Info panel is closed, and without one", async () => {
    remember({ ai: false, editor: true, info: false, preview: false });
    const { unmount } = render(<SceneEditorModal info={info} sceneId="scene-1" />);
    await waitFor(() => expect(screen.getByText("Loaded")).toBeTruthy());
    expect(document.querySelector(".editor-modal__title")!.textContent).toContain("Loaded");
    fireEvent.click(panelToggle("Info"));
    expect(document.querySelector(".editor-modal__title")!.textContent).not.toContain("Loaded");
    expect(screen.getByTestId("info-heading").textContent).toContain("Loaded");
    unmount();

    render(<SceneEditorModal sceneId="scene-1" />);
    await waitFor(() => expect(screen.getByText("Loaded")).toBeTruthy());
    expect(document.querySelector(".editor-modal__title")!.textContent).toContain("Loaded");
  });

  it("puts Back first in the bar, going back in history when one of our pages led here", async () => {
    setReferrer(`${window.location.origin}/store`);
    window.history.pushState(null, "", "/s/clock");
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    render(<SceneEditorModal info={info} sceneId="scene-1" />);
    const bar = document.querySelector(".editor-modal__bar")!;
    expect(bar.querySelector("button, a")).toBe(backButton());
    expect(backButton().getAttribute("title")).toBe("Back");
    expect(screen.queryByRole("button", { name: /Close/ })).toBeNull();

    fireEvent.click(backButton());
    expect(back).toHaveBeenCalledOnce();
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("asks the Navigation API where the previous entry was, when there is one", async () => {
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    const navigation = {
      currentEntry: { index: 1 },
      entries: () => [{ url: `${window.location.origin}/my-scenes` }, { url: window.location.href }],
    };
    Object.defineProperty(window, "navigation", { configurable: true, value: navigation });
    try {
      const { unmount } = render(<SceneEditorModal sceneId="scene-1" />);
      fireEvent.click(backButton());
      expect(back).toHaveBeenCalledOnce();
      unmount();

      // A referrer of ours means nothing when the previous entry is not.
      setReferrer(`${window.location.origin}/store`);
      navigation.entries = () => [{ url: "https://www.example.com/" }, { url: window.location.href }];
      render(<SceneEditorModal backUrl="/store" sceneId="scene-1" />);
      fireEvent.click(backButton());
      expect(back).toHaveBeenCalledOnce();
      expect(pushMock).toHaveBeenCalledWith("/store");
    } finally {
      delete (window as { navigation?: unknown }).navigation;
    }
  });

  it("goes to the store front when the visitor came from elsewhere", async () => {
    setReferrer("https://www.example.com/");
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    const { unmount } = render(<SceneEditorModal backUrl="/store" sceneId="scene-1" />);
    fireEvent.click(backButton());
    expect(back).not.toHaveBeenCalled();
    expect(pushMock).toHaveBeenCalledWith("/store");
    unmount();

    // No referrer at all (a typed URL, a bookmark): the store as well.
    setReferrer("");
    pushMock.mockClear();
    render(<SceneEditorModal sceneId="scene-1" />);
    fireEvent.click(backButton());
    expect(pushMock).toHaveBeenCalledWith("/");
  });
});

describe("SceneEditorModal scene name", () => {
  async function openEditor() {
    remember({ ai: false, editor: true, info: false, preview: false });
    render(<SceneEditorModal canSave sceneId="scene-1" />);
    await screen.findByTestId("editor");
    fireEvent.click(screen.getByRole("button", { name: "emit echo" }));
    expect(screen.getByText("Loaded")).toBeTruthy();
    expect(screen.queryByText("Unsaved changes")).toBeNull();
  }

  it("shows the scene's name and renames it through the editor, into Save", async () => {
    await openEditor();
    fireEvent.click(screen.getByRole("button", { name: "Rename scene" }));
    const input = renameInput();
    expect(input.value).toBe("Loaded");

    fireEvent.change(input, { target: { value: "  Birthdays  " } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(screen.queryByRole("textbox", { name: "Scene name" })).toBeNull();
    expect(screen.getByText("Birthdays")).toBeTruthy();
    // Through the editor's own rename path (the diagram keeps its layout)…
    expect(renameCalls).toEqual([["s1", "Birthdays"]]);
    // …and the echo marks the scenes dirty, so Save lights up.
    expect(screen.getByText("Unsaved changes")).toBeTruthy();

    vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: /Save as new version/ }));
    await waitFor(() => expect(postedContent()).not.toBeNull());
    expect(postedContent()?.scenes[0]?.name).toBe("Birthdays");
    // Saved: the workspace stays, clean, and the page's data is refreshed.
    await waitFor(() => expect(screen.queryByText("Unsaved changes")).toBeNull());
    expect(refreshMock).toHaveBeenCalled();
    expect(screen.getByTestId("editor")).toBeTruthy();
  });

  it("renames from the Info panel's heading, through the editor, into Save", async () => {
    remember({ ai: false, editor: true, info: true, preview: false });
    render(<SceneEditorModal canSave info={info} sceneId="scene-1" />);
    await screen.findByTestId("editor");
    fireEvent.click(screen.getByRole("button", { name: "emit echo" }));
    const heading = screen.getByTestId("info-heading");
    fireEvent.click(within(heading).getByRole("button", { name: "Rename scene" }));
    const input = within(heading).getByRole("textbox", { name: "Scene name" }) as HTMLInputElement;
    expect(input.value).toBe("Loaded");
    fireEvent.change(input, { target: { value: "From the panel" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(within(heading).getByText("From the panel")).toBeTruthy();
    expect(renameCalls).toEqual([["s1", "From the panel"]]);
    expect(screen.getByText("Unsaved changes")).toBeTruthy();

    vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: /Save as new version/ }));
    await waitFor(() => expect(postedContent()?.scenes[0]?.name).toBe("From the panel"));
  });

  it("follows the editor's own rename", async () => {
    await openEditor();
    fireEvent.click(screen.getByRole("button", { name: "emit edit" }));
    expect(screen.getByText("Edited")).toBeTruthy();
    expect(screen.queryByText("Loaded")).toBeNull();
  });

  it("cancels the rename on Escape", async () => {
    await openEditor();
    fireEvent.click(screen.getByRole("button", { name: "Rename scene" }));
    const input = renameInput();
    fireEvent.change(input, { target: { value: "Nope" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(screen.queryByRole("textbox", { name: "Scene name" })).toBeNull();
    expect(screen.getByText("Loaded")).toBeTruthy();
    expect(screen.queryByText("Unsaved changes")).toBeNull();
    expect(renameCalls).toEqual([]);
  });

  it("refuses an empty name on Enter and drops it on blur", async () => {
    await openEditor();
    fireEvent.click(screen.getByRole("button", { name: "Rename scene" }));
    const input = renameInput();
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });

    // Still editing, flagged.
    expect(renameInput().getAttribute("aria-invalid")).toBe("true");
    expect(renameCalls).toEqual([]);

    fireEvent.blur(renameInput());
    expect(screen.queryByRole("textbox", { name: "Scene name" })).toBeNull();
    expect(screen.getByText("Loaded")).toBeTruthy();
    expect(screen.queryByText("Unsaved changes")).toBeNull();
    expect(renameCalls).toEqual([]);
  });

  it("commits on blur", async () => {
    await openEditor();
    fireEvent.click(screen.getByRole("button", { name: "Rename scene" }));
    fireEvent.change(renameInput(), { target: { value: "Blurred" } });
    fireEvent.blur(renameInput());
    expect(screen.getByText("Blurred")).toBeTruthy();
    expect(renameCalls).toEqual([["s1", "Blurred"]]);
  });

  it("renames before the editor has mounted, by handing it the renamed scenes", async () => {
    remember({ ai: false, editor: false, info: false, preview: true });
    render(<SceneEditorModal canSave sceneId="scene-1" />);
    await waitFor(() => expect(screen.getByText("Loaded")).toBeTruthy());
    expect(screen.queryByTestId("editor")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Rename scene" }));
    fireEvent.change(renameInput(), { target: { value: "Early" } });
    fireEvent.keyDown(renameInput(), { key: "Enter" });
    expect(screen.getByText("Early")).toBeTruthy();
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    expect(renameCalls).toEqual([]);
    // The preview runs the renamed scenes…
    expect(screen.getByTestId("preview-panel").dataset.scenes).toBe(
      JSON.stringify([{ default: true, id: "s1", name: "Early" }]),
    );
    // …and so does the editor once it opens.
    fireEvent.click(panelToggle("Editor"));
    expect(screen.getByTestId("editor")).toBeTruthy();
  });

  it("follows the scene selected in the editor when there are several", async () => {
    scenesJson = twoScenes;
    remember({ ai: false, editor: true, info: false, preview: true });
    render(<SceneEditorModal canSave sceneId="scene-1" />);
    await screen.findByTestId("preview-panel");
    await screen.findByTestId("editor");
    expect(screen.getByText("Loaded")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "select s2" }));
    expect(screen.getByText("Second")).toBeTruthy();
    expect(screen.queryByText("Loaded")).toBeNull();
    // The preview and the AI panel follow the tab too.
    expect(screen.getByTestId("preview-panel").dataset.editorScene).toBe("s2");

    fireEvent.click(screen.getByRole("button", { name: "Rename scene" }));
    fireEvent.change(renameInput(), { target: { value: "Party" } });
    fireEvent.keyDown(renameInput(), { key: "Enter" });
    expect(renameCalls).toEqual([["s2", "Party"]]);
    expect(screen.getByText("Party")).toBeTruthy();
    expect(screen.getByTestId("preview-panel").dataset.scenes).toBe(
      JSON.stringify([loadedScenes[0], { id: "s2", name: "Party" }]),
    );
  });
});

// The bar's overflow measurement, as the test wants it: the bar's right
// edge, the title's right edge (what is left between them is the actions'
// room) and every other element `childWidth` wide (each action button).
// The bar measures its own inner width and the widths of the title's and
// the cluster's children (jsdom measures nothing): a bar of `barWidth` with
// three title children and four actions, each `childWidth` wide.
function barRects(childWidth = 120) {
  return function (this: HTMLElement) {
    return { width: childWidth } as DOMRect;
  };
}
function stubBarWidth(barWidth: number) {
  return vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("editor-modal__bar") ? barWidth : 0;
  });
}
function barElement() {
  return document.querySelector(".editor-modal__bar") as HTMLElement;
}
function moreButton() {
  return screen.getByRole("button", { name: "More actions" });
}

describe("SceneEditorModal bar overflow", () => {
  beforeEach(() => {
    observers.clear();
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  });

  it("collapses the actions into a … menu when the bar has no room, and brings them back when it does", async () => {
    // Four actions of 120 need 480; 1400 − a 360-wide title leaves 1040.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(barRects());
    const width = stubBarWidth(1400);
    render(<SceneEditorModal canFork canSave downloadUrl="/dl.zip" info={info} sceneId="scene-1" />);
    expect(screen.getByRole("button", { name: "Install" })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Download \.zip/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "More actions" })).toBeNull();

    // 700 − 360 leaves 340: not enough.
    width.mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("editor-modal__bar") ? 700 : 0;
    });
    fakeResize(barElement(), 700);
    const more = moreButton();
    expect(more.getAttribute("aria-haspopup")).toBe("menu");
    expect(more.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
    expect(screen.queryByRole("link", { name: /Download \.zip/ })).toBeNull();
    expect(screen.queryByRole("menu")).toBeNull();

    // The menu lists the same actions, the primary (Save, for an owner)
    // first, with the same disabled states and the same link.
    fireEvent.click(more);
    expect(more.getAttribute("aria-expanded")).toBe("true");
    const items = within(screen.getByRole("menu")).getAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual([
      "Save as new version",
      "Install",
      "Fork & save copy",
      "Download .zip",
    ]);
    expect((items[0] as HTMLButtonElement).disabled).toBe(true);
    expect((items[1] as HTMLButtonElement).disabled).toBe(false);
    expect((items[2] as HTMLButtonElement).disabled).toBe(false);
    expect(items[3]!.getAttribute("href")).toBe("/dl.zip");

    // Escape closes it and puts focus back on the button.
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(more.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(more);

    // An outside click closes it; a click inside does not.
    fireEvent.click(more);
    fireEvent.pointerDown(screen.getByRole("menu"));
    expect(screen.getByRole("menu")).toBeTruthy();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();

    // Wide again: the buttons are back.
    width.mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("editor-modal__bar") ? 1400 : 0;
    });
    fakeResize(barElement(), 1400);
    expect(screen.queryByRole("button", { name: "More actions" })).toBeNull();
    expect(screen.getByRole("button", { name: "Install" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save as new version" })).toBeTruthy();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  });

  it("moves between the enabled items with the arrow keys, and runs the chosen one", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(barRects());
    stubBarWidth(700);
    render(<SceneEditorModal canFork canSave downloadUrl="/dl.zip" info={info} sceneId="scene-1" />);
    await screen.findByTestId("editor");
    fireEvent.click(moreButton());
    const menu = screen.getByRole("menu");
    const item = (name: string) => within(menu).getByRole("menuitem", { name });
    // Save is disabled (nothing edited): the first enabled item gets focus.
    expect(document.activeElement).toBe(item("Install"));
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(item("Fork & save copy"));
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(item("Download .zip"));
    // Wraps, both ways.
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(item("Install"));
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(document.activeElement).toBe(item("Download .zip"));
    fireEvent.keyDown(menu, { key: "Home" });
    expect(document.activeElement).toBe(item("Install"));
    fireEvent.keyDown(menu, { key: "End" });
    expect(document.activeElement).toBe(item("Download .zip"));

    // A choice runs the action and closes the menu.
    fireEvent.click(item("Install"));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByTestId("install-dialog")).toBeTruthy();

    // After an edit the Unsaved pill shows in the title, and Save is live.
    fireEvent.click(screen.getByRole("button", { name: "emit echo" }));
    fireEvent.click(screen.getByRole("button", { name: "emit edit" }));
    expect(document.querySelector(".editor-modal__title")!.contains(screen.getByText("Unsaved changes"))).toBe(true);
    fireEvent.click(moreButton());
    expect((within(screen.getByRole("menu")).getByRole("menuitem", { name: "Save as new version" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("puts Fork first in the menu for a visitor who cannot save", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(barRects());
    stubBarWidth(700);
    render(<SceneEditorModal canFork downloadUrl="/dl.zip" info={info} sceneId="scene-1" />);
    fireEvent.click(moreButton());
    expect(within(screen.getByRole("menu")).getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Fork & save copy",
      "Install",
      "Download .zip",
    ]);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  });
});

// The single-panel media query, flipped by the test.
const mediaListeners = new Set<() => void>();
let narrowViewport = false;
function stubMatchMedia() {
  vi.stubGlobal("matchMedia", (media: string) => ({
    addEventListener: (_type: string, listener: () => void) => mediaListeners.add(listener),
    get matches() {
      return media === "(max-width: 900px)" && narrowViewport;
    },
    media,
    removeEventListener: (_type: string, listener: () => void) => mediaListeners.delete(listener),
  }));
}
function setViewport(narrow: boolean) {
  narrowViewport = narrow;
  act(() => mediaListeners.forEach((listener) => listener()));
}
function tabs() {
  return within(screen.getByRole("tablist", { name: "Panels" }))
    .getAllByRole("tab")
    .map((tab) => `${tab.textContent}${tab.getAttribute("aria-selected") === "true" ? "*" : ""}`);
}

describe("SceneEditorModal single-panel mode", () => {
  beforeEach(() => {
    mediaListeners.clear();
    narrowViewport = false;
    stubMatchMedia();
  });

  it("shows one panel of the set at a time on a narrow viewport, the toggles as tabs", async () => {
    narrowViewport = true;
    remember({ ai: false, editor: true, info: true, preview: true });
    render(<SceneEditorModal info={info} sceneId="scene-1" />);
    // The Preview, being in the set, is the one shown first.
    expect(tabs()).toEqual(["Info", "Editor", "AI", "Preview*"]);
    await screen.findByTestId("preview-panel");
    expect(screen.queryByTestId("info-panel")).toBeNull();
    expect(screen.queryByTestId("ai-panel")).toBeNull();
    expect(editorCell().hidden).toBe(true);
    expect(screen.queryByRole("separator")).toBeNull();
    // With the Info panel off screen the bar carries the name.
    await waitFor(() => expect(screen.getByText("Loaded")).toBeTruthy());
    expect(document.querySelector(".editor-modal__title")!.textContent).toContain("Loaded");

    // A tab shows just that panel; the set (and its hash / memory) is as it was.
    fireEvent.click(screen.getByRole("tab", { name: "Editor" }));
    expect(tabs()).toEqual(["Info", "Editor*", "AI", "Preview"]);
    expect(editorCell().hidden).toBe(false);
    expect(screen.queryByTestId("preview-panel")).toBeNull();
    expect(window.location.hash).toBe("");
    expect(storedPanels()).toEqual({ ai: false, editor: true, info: true, preview: true });

    // A panel outside the set joins it (a wide viewport shows it too).
    fireEvent.click(screen.getByRole("tab", { name: "AI" }));
    expect(tabs()).toEqual(["Info", "Editor", "AI*", "Preview"]);
    expect(screen.getByTestId("ai-panel")).toBeTruthy();
    expect(editorCell().hidden).toBe(true);
    expect(window.location.hash).toBe("#scene-editor-info-preview-ai");
    expect(storedPanels()).toEqual({ ai: true, editor: true, info: true, preview: true });

    // Wide again: the whole set, side by side.
    setViewport(false);
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(pressed()).toEqual({ AI: true, Editor: true, Info: true, Preview: true });
    expect(screen.getByTestId("info-panel")).toBeTruthy();
    expect(screen.getByTestId("ai-panel")).toBeTruthy();
    await screen.findByTestId("preview-panel");
    expect(editorCell().hidden).toBe(false);
    expect(screen.getAllByRole("separator")).toHaveLength(3);

    // Narrow once more: the last panel picked there.
    setViewport(true);
    expect(tabs()).toEqual(["Info", "Editor", "AI*", "Preview"]);
    expect(screen.getByTestId("ai-panel")).toBeTruthy();
    expect(screen.queryByTestId("info-panel")).toBeNull();
    // Dropping it from the set on a wide viewport forgets the pick.
    setViewport(false);
    fireEvent.click(panelToggle("AI"));
    setViewport(true);
    expect(tabs()).toEqual(["Info", "Editor", "AI", "Preview*"]);
  });

  it("starts on the Info panel without a Preview in the set, else on the first open one", async () => {
    narrowViewport = true;
    remember({ ai: true, editor: true, info: true, preview: false });
    const { unmount } = render(<SceneEditorModal info={info} sceneId="scene-1" />);
    expect(tabs()).toEqual(["Info*", "Editor", "AI", "Preview"]);
    expect(screen.getByTestId("info-panel")).toBeTruthy();
    expect(screen.queryByTestId("ai-panel")).toBeNull();
    unmount();

    remember({ ai: true, editor: true, info: false, preview: false });
    render(<SceneEditorModal info={info} sceneId="scene-1" />);
    expect(tabs()).toEqual(["Info", "Editor*", "AI", "Preview"]);
    await screen.findByTestId("editor");
    expect(editorCell().hidden).toBe(false);
    expect(screen.queryByTestId("ai-panel")).toBeNull();
  });

  it("picks the panel to show from the set (the pure helper)", () => {
    const set = (names: string[]) => ({
      ai: names.includes("ai"),
      editor: names.includes("editor"),
      info: names.includes("info"),
      preview: names.includes("preview"),
    });
    expect(singlePanelFor(set(["info", "editor", "preview"]), null)).toBe("preview");
    expect(singlePanelFor(set(["info", "editor", "preview"]), "editor")).toBe("editor");
    // A pick that left the set does not count.
    expect(singlePanelFor(set(["info", "editor", "preview"]), "ai")).toBe("preview");
    expect(singlePanelFor(set(["info", "editor", "ai"]), null)).toBe("info");
    expect(singlePanelFor(set(["editor", "ai"]), null)).toBe("editor");
    expect(singlePanelFor(set(["ai"]), null)).toBe("ai");
    expect(singlePanelFor(set([]), null)).toBeNull();
  });
});

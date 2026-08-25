// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useEffect, useRef, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    <div data-show-preview={String(props.showPreviewButton)} data-testid="editor">
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
  scenes?: readonly unknown[] | null | undefined;
  initialSource?: string | undefined;
  versions?: readonly unknown[] | undefined;
  editorSceneId?: string | null | undefined;
  versionRequest?: { version: number } | null | undefined;
  onSourceChange?: ((source: { kind: string; version?: number | null }) => void) | undefined;
};
vi.mock("./SceneLivePreview", () => ({
  SceneLivePreviewPanel: (props: PanelProps) => (
    <div
      data-editor-scene={props.editorSceneId ?? ""}
      data-scenes={JSON.stringify(props.scenes)}
      data-source={props.initialSource}
      data-testid="preview-panel"
      data-version-request={props.versionRequest?.version ?? ""}
      data-versions={props.versions?.length ?? 0}
    >
      <button onClick={() => props.onSourceChange?.({ kind: "version", version: 1 })} type="button">
        report v1
      </button>
    </div>
  ),
}));
vi.mock("./SceneAiPanel", () => ({
  SceneAiPanel: (props: { initialPrompt?: string | undefined }) => (
    <div data-prompt={props.initialPrompt ?? ""} data-testid="ai-panel" />
  ),
}));
type InfoProps = {
  viewingVersion: number | null;
  onSelectVersion?: ((version: number) => void) | undefined;
  heading?: ReactNode;
  scene: { name: string };
};
vi.mock("./SceneInfoPanel", () => ({
  SceneInfoPanel: (props: InfoProps) => (
    <div data-scene={props.scene.name} data-testid="info-panel" data-viewing={props.viewingVersion ?? ""}>
      <div data-testid="info-heading">{props.heading}</div>
      <button onClick={() => props.onSelectVersion?.(1)} type="button">
        pick v1
      </button>
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
let scenesJson: unknown[] = loadedScenes;
const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.includes("/scenes.json")) {
    return Response.json(scenesJson);
  }
  if (url.endsWith("/content") && init?.method === "POST") {
    return Response.json({ ok: true });
  }
  throw new Error(`Unexpected fetch: ${url}`);
});

function postedContent() {
  const call = fetchMock.mock.calls.find(([input]) => String(input).endsWith("/content"));
  return call ? (JSON.parse(String(call[1]?.body)) as { scenes: { name: string }[] }) : null;
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
    expect(panel.dataset.source).toBe("editor");
    expect(panel.dataset.versions).toBe("2");
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

  it("starts the Preview panel on the pinned version when the page is pinned", async () => {
    render(<SceneEditorModal pinnedVersion={1} sceneId="scene-1" versions={versions} />);
    const panel = await screen.findByTestId("preview-panel");
    expect(panel.dataset.source).toBe("version");
  });
});

describe("SceneEditorModal Info panel", () => {
  it("runs a version picked in the Info table in the Preview panel, opening it when closed", async () => {
    remember({ ai: false, editor: true, info: true, preview: false });
    render(<SceneEditorModal info={info} sceneId="scene-1" versions={versions} />);
    await screen.findByTestId("editor");
    expect(screen.queryByTestId("preview-panel")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "pick v1" }));
    expect(window.location.hash).toBe("#scene-editor-info-preview");
    const panel = await screen.findByTestId("preview-panel");
    expect(panel.dataset.versionRequest).toBe("1");
    // The panel reports what it runs; the table marks it.
    expect(screen.getByTestId("info-panel").dataset.viewing).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "report v1" }));
    expect(screen.getByTestId("info-panel").dataset.viewing).toBe("1");

    // Closing the preview forgets both.
    fireEvent.click(panelToggle("Preview"));
    expect(screen.getByTestId("info-panel").dataset.viewing).toBe("");
    fireEvent.click(panelToggle("Preview"));
    expect((await screen.findByTestId("preview-panel")).dataset.versionRequest).toBe("");
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

    // The Preview panel runs v1 (not the latest, v2): a cloud install pins it.
    await screen.findByTestId("preview-panel");
    fireEvent.click(screen.getByRole("button", { name: "report v1" }));
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

  it("lays the bar out as Back, the panel toggles, then Save / Fork / Download on the right", async () => {
    render(
      <SceneEditorModal
        canFork
        canSave
        downloadUrl="/api/store/scenes/scene-1/download"
        info={info}
        sceneId="scene-1"
      />,
    );
    const left = document.querySelector(".editor-modal__title")!;
    const label = (child: Element) => child.getAttribute("aria-label") ?? child.textContent?.trim();
    expect(Array.from(left.children).map(label)).toEqual(["Back", "Panels"]);
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
    // Editing puts the Unsaved pill beside the actions.
    fireEvent.click(await screen.findByRole("button", { name: "emit echo" }));
    fireEvent.click(screen.getByRole("button", { name: "emit edit" }));
    expect(Array.from(right.children).map(label)[0]).toBe("Unsaved changes");
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

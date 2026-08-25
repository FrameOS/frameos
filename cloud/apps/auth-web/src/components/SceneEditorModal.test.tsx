// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openLivePreviewView } from "../lib/scene-views";
import { PANELS_STORAGE_KEY, SceneEditorModal } from "./SceneEditorModal";

// The embedded editor is kea + reactflow + Monaco: stood in for by a stub
// that shows the props this modal is responsible for, lets a test push an
// edit through onScenesChanged, switch scene tabs, and answers the host's
// rename through apiRef the way the real editor does (an echo of the
// renamed scenes through onScenesChanged).
type StubEditorApi = { renameScene: (sceneId: string, name: string) => void };
type StubEditorProps = {
  scenes: unknown[];
  showPreviewButton?: boolean | undefined;
  onScenesChanged?: ((scenes: unknown[]) => void) | undefined;
  onSelectedSceneChanged?: ((sceneId: string | null) => void) | undefined;
  apiRef?: { current: StubEditorApi | null } | undefined;
};
const renameCalls: Array<[string, string]> = [];
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
};
vi.mock("./SceneLivePreview", () => ({
  SceneLivePreviewPanel: (props: PanelProps) => (
    <div
      data-editor-scene={props.editorSceneId ?? ""}
      data-scenes={JSON.stringify(props.scenes)}
      data-source={props.initialSource}
      data-testid="preview-panel"
      data-versions={props.versions?.length ?? 0}
    />
  ),
}));
vi.mock("./SceneAiPanel", () => ({
  SceneAiPanel: () => <div data-testid="ai-panel" />,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
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

function panelToggle(name: "Preview" | "AI") {
  return screen.getByRole("button", { name }) as HTMLButtonElement;
}

function storedPanels() {
  return JSON.parse(window.localStorage.getItem(PANELS_STORAGE_KEY) ?? "null");
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  window.localStorage.clear();
  window.history.replaceState(null, "", "/s/clock");
  scenesJson = loadedScenes;
  renameCalls.length = 0;
});

afterEach(() => {
  cleanup();
  fetchMock.mockClear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("SceneEditorModal entry points", () => {
  it("opens the editor with the Preview panel from the Live preview link", async () => {
    render(<SceneEditorModal canPreview sceneId="scene-1" versions={versions} />);
    const link = screen.getByRole("link", { name: /Live preview/ });
    expect(link.getAttribute("href")).toBe("#scene-editor-preview");

    fireEvent.click(link);

    expect(window.location.hash).toBe("#scene-editor-preview");
    expect(window.history.state).toEqual({ frameosSceneEditor: true });
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(panelToggle("Preview").getAttribute("aria-pressed")).toBe("true");
    expect(panelToggle("AI").getAttribute("aria-pressed")).toBe("false");
    // The panel mounts once scenes.json is in, on the editor's scenes.
    const panel = await screen.findByTestId("preview-panel");
    expect(panel.dataset.scenes).toBe(JSON.stringify(loadedScenes));
    expect(panel.dataset.source).toBe("editor");
    expect(panel.dataset.versions).toBe("2");
    expect(panel.dataset.editorScene).toBe("s1");
    expect(screen.queryByTestId("ai-panel")).toBeNull();
    // The editor's own wasm preview button is hidden in favour of the panel.
    expect(screen.getByTestId("editor").dataset.showPreview).toBe("false");
  });

  it("starts the Preview panel on the pinned version when the page is pinned", async () => {
    render(<SceneEditorModal canPreview pinnedVersion={1} sceneId="scene-1" versions={versions} />);
    fireEvent.click(screen.getByRole("link", { name: /Live preview/ }));
    const panel = await screen.findByTestId("preview-panel");
    expect(panel.dataset.source).toBe("version");
  });

  it("opens with the panels remembered from last time, plus the one the link is about", () => {
    window.localStorage.setItem(PANELS_STORAGE_KEY, JSON.stringify({ ai: true, preview: false }));
    render(<SceneEditorModal canPreview canRemix sceneId="scene-1" />);

    fireEvent.click(screen.getByRole("link", { name: /Live preview/ }));
    expect(window.location.hash).toBe("#scene-editor-preview-ai");
    expect(panelToggle("Preview").getAttribute("aria-pressed")).toBe("true");
    expect(panelToggle("AI").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("ai-panel")).toBeTruthy();
  });

  it("opens with just the Preview panel when nothing is remembered yet", () => {
    render(<SceneEditorModal canRemix sceneId="scene-1" />);
    fireEvent.click(screen.getByRole("link", { name: "View diagram" }));
    expect(window.location.hash).toBe("#scene-editor-preview");
    expect(panelToggle("Preview").getAttribute("aria-pressed")).toBe("true");
    expect(panelToggle("AI").getAttribute("aria-pressed")).toBe("false");
  });

  it("keeps a remembered no-panel choice", () => {
    window.localStorage.setItem(PANELS_STORAGE_KEY, JSON.stringify({ ai: false, preview: false }));
    render(<SceneEditorModal sceneId="scene-1" />);
    fireEvent.click(screen.getByRole("link", { name: "View diagram" }));
    expect(window.location.hash).toBe("#scene-editor");
    expect(panelToggle("Preview").getAttribute("aria-pressed")).toBe("false");
  });

  it("opens the plain editor with whatever was remembered", () => {
    window.localStorage.setItem(PANELS_STORAGE_KEY, JSON.stringify({ ai: false, preview: true }));
    render(<SceneEditorModal sceneId="scene-1" />);
    fireEvent.click(screen.getByRole("link", { name: "View diagram" }));
    expect(window.location.hash).toBe("#scene-editor-preview");
    expect(panelToggle("Preview").getAttribute("aria-pressed")).toBe("true");
  });

  it("opens from the gallery's hash push and from the old #live-preview links", async () => {
    render(<SceneEditorModal sceneId="scene-1" />);
    expect(screen.queryByRole("dialog")).toBeNull();

    act(() => openLivePreviewView());
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(panelToggle("Preview").getAttribute("aria-pressed")).toBe("true");
    await screen.findByTestId("preview-panel");

    fireEvent.click(screen.getByRole("button", { name: /Close/ }));
    // Back pops the tagged entry; jsdom's history fires popstate asynchronously.
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    window.history.replaceState(null, "", "/s/clock#live-preview");
    act(() => window.dispatchEvent(new Event("hashchange")));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(panelToggle("Preview").getAttribute("aria-pressed")).toBe("true");
    // The URL is brought onto the current spelling.
    expect(window.location.hash).toBe("#scene-editor-preview");
  });
});

describe("SceneEditorModal bar", () => {
  it("offers the store zip the page links to, when it has one", async () => {
    const { unmount } = render(
      <SceneEditorModal downloadUrl="/api/store/scenes/scene-1/download?share=tok" sceneId="scene-1" />,
    );
    fireEvent.click(screen.getByRole("link", { name: "View diagram" }));
    const link = screen.getByRole("link", { name: /Download \.zip/ });
    expect(link.getAttribute("href")).toBe("/api/store/scenes/scene-1/download?share=tok");
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    unmount();

    window.history.replaceState(null, "", "/s/clock");
    render(<SceneEditorModal sceneId="scene-1" />);
    fireEvent.click(screen.getByRole("link", { name: "View diagram" }));
    expect(screen.queryByRole("link", { name: /Download \.zip/ })).toBeNull();
  });
});

describe("SceneEditorModal panel toggles", () => {
  it("toggles Preview and AI independently, keeps the hash truthful and remembers the choice", async () => {
    window.localStorage.setItem(PANELS_STORAGE_KEY, JSON.stringify({ ai: false, preview: false }));
    render(<SceneEditorModal canRemix sceneId="scene-1" />);
    fireEvent.click(screen.getByRole("link", { name: "View diagram" }));
    expect(window.location.hash).toBe("#scene-editor");
    expect(screen.queryByTestId("preview-panel")).toBeNull();
    expect(screen.queryByTestId("ai-panel")).toBeNull();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    fireEvent.click(panelToggle("Preview"));
    expect(window.location.hash).toBe("#scene-editor-preview");
    expect(storedPanels()).toEqual({ ai: false, preview: true });
    await screen.findByTestId("preview-panel");

    fireEvent.click(panelToggle("AI"));
    expect(window.location.hash).toBe("#scene-editor-preview-ai");
    expect(storedPanels()).toEqual({ ai: true, preview: true });
    const previewPanel = screen.getByTestId("preview-panel");
    const aiPanel = screen.getByTestId("ai-panel");
    // Column order: diagram, AI, Preview — the preview is rightmost.
    expect(
      aiPanel.compareDocumentPosition(previewPanel) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      screen.getByTestId("editor").compareDocumentPosition(aiPanel) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    fireEvent.click(panelToggle("Preview"));
    expect(window.location.hash).toBe("#scene-editor-ai");
    expect(storedPanels()).toEqual({ ai: true, preview: false });
    expect(screen.queryByTestId("preview-panel")).toBeNull();
    expect(screen.getByTestId("ai-panel")).toBeTruthy();

    fireEvent.click(panelToggle("AI"));
    expect(window.location.hash).toBe("#scene-editor");
    expect(storedPanels()).toEqual({ ai: false, preview: false });
    expect(screen.queryByTestId("ai-panel")).toBeNull();
    // Toggling replaces the hash in place: still one entry to pop on Close.
    expect(window.history.state).toEqual({ frameosSceneEditor: true });
  });

  it("does not count the editor's normalised echo of the loaded scenes as an edit", async () => {
    render(<SceneEditorModal canSave sceneId="scene-1" />);
    fireEvent.click(screen.getByRole("link", { name: "Edit scene" }));
    await waitFor(() => expect(screen.getByTestId("editor")).toBeTruthy());
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

  it("feeds the editor's edits to the Preview panel", async () => {
    render(<SceneEditorModal canPreview sceneId="scene-1" />);
    fireEvent.click(screen.getByRole("link", { name: /Live preview/ }));
    const panel = await screen.findByTestId("preview-panel");
    expect(panel.dataset.scenes).toBe(JSON.stringify(loadedScenes));

    fireEvent.click(screen.getByRole("button", { name: "emit edit" }));
    expect(screen.getByTestId("preview-panel").dataset.scenes).toBe(
      JSON.stringify([{ id: "s1", name: "Edited" }]),
    );
  });

  it("hands the Preview panel the current scenes when it is opened after edits", async () => {
    window.localStorage.setItem(PANELS_STORAGE_KEY, JSON.stringify({ ai: false, preview: false }));
    render(<SceneEditorModal sceneId="scene-1" />);
    fireEvent.click(screen.getByRole("link", { name: "View diagram" }));
    await waitFor(() => expect(screen.getByTestId("editor")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "emit edit" }));

    fireEvent.click(panelToggle("Preview"));
    const panel = await screen.findByTestId("preview-panel");
    expect(panel.dataset.scenes).toBe(JSON.stringify([{ id: "s1", name: "Edited" }]));
  });
});

describe("SceneEditorModal scene name", () => {
  async function openEditor() {
    render(<SceneEditorModal canSave sceneId="scene-1" />);
    fireEvent.click(screen.getByRole("link", { name: "Edit scene" }));
    await waitFor(() => expect(screen.getByTestId("editor")).toBeTruthy());
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

  it("follows the scene selected in the editor when there are several", async () => {
    scenesJson = twoScenes;
    render(<SceneEditorModal canPreview canSave sceneId="scene-1" />);
    fireEvent.click(screen.getByRole("link", { name: /Live preview/ }));
    await screen.findByTestId("preview-panel");
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

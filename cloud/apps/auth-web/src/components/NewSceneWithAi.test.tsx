// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useEffect, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NewSceneWithAi } from "./NewSceneWithAi";
import {
  newSceneDraftKey,
  readNewSceneDraft,
  type NewSceneDraft,
} from "../lib/new-scene-draft";

// The embedded editor stood in for by a stub that answers the host's rename
// through apiRef the way the real editor does: an echo of the renamed
// scenes through onScenesChanged.
type StubEditorApi = { renameScene: (sceneId: string, name: string) => void };
type StubEditorProps = {
  scenes: { id: string }[];
  onScenesChanged?: ((scenes: unknown[]) => void) | undefined;
  apiRef?: { current: StubEditorApi | null } | undefined;
};
function StubEditor(props: StubEditorProps) {
  const currentRef = useRef<{ id: string }[]>(props.scenes);
  useEffect(() => {
    currentRef.current = props.scenes;
  }, [props.scenes]);
  useEffect(() => {
    const apiRef = props.apiRef;
    if (!apiRef) {
      return;
    }
    apiRef.current = {
      renameScene: (sceneId, name) => {
        currentRef.current = currentRef.current.map((scene) =>
          scene.id === sceneId ? { ...scene, name } : scene,
        );
        props.onScenesChanged?.(currentRef.current);
      },
    };
    return () => {
      apiRef.current = null;
    };
  });
  return <div data-testid="editor" />;
}
vi.mock("next/dynamic", () => ({ default: () => StubEditor }));
vi.mock("./SceneLivePreview", () => ({ SceneLivePreviewPanel: () => null }));
vi.mock("./SceneAiPanel", () => ({
  SceneAiPanel: (props: { initialPrompt?: string; initialChat?: { chatId: string } }) => (
    <div
      data-chat={props.initialChat?.chatId ?? ""}
      data-prompt={props.initialPrompt ?? ""}
      data-testid="ai-panel"
    />
  ),
}));

const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
  const url = String(input);
  if (url.endsWith("/api/account/scenes")) {
    return Response.json({ error: "scene_quota_exceeded" }, { status: 429 });
  }
  throw new Error(`Unexpected fetch: ${url}`);
});

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  fetchMock.mockClear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("NewSceneWithAi hand-off", () => {
  it("opens handed-off scenes as they are, unsaved, preview beside the editor", async () => {
    const storage = new Map<string, string>([
      ["frameos:converted-scenes", JSON.stringify([{ id: "s1", name: "Heater", nodes: [], edges: [], settings: { execution: "interpreted" } }])],
    ]);
    Object.defineProperty(window, "sessionStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        removeItem: (key: string) => void storage.delete(key),
        setItem: (key: string, value: string) => void storage.set(key, value),
      },
    });
    render(<NewSceneWithAi handoffKey="frameos:converted-scenes" myScenesUrl="/scenes" />);
    await waitFor(() => expect(screen.getByTestId("editor")).toBeTruthy());
    expect(screen.getByText("Heater")).toBeTruthy();
    expect(screen.getByText("Not saved yet")).toBeTruthy();
    // Read once: a reload starts blank rather than re-opening a stale copy.
    expect(storage.has("frameos:converted-scenes")).toBe(false);
    expect(screen.queryByTestId("ai-panel")).toBeNull();
  });
});

describe("NewSceneWithAi scene name", () => {
  it("names the new scene from the bar, and Save to my scenes sends that name", async () => {
    render(<NewSceneWithAi myScenesUrl="/scenes" />);
    await waitFor(() => expect(screen.getByTestId("editor")).toBeTruthy());
    expect(screen.getByText("New scene")).toBeTruthy();
    expect(screen.queryByText("Not saved yet")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Rename scene" }));
    const input = screen.getByRole("textbox", { name: "Scene name" }) as HTMLInputElement;
    expect(input.value).toBe("New scene");
    fireEvent.change(input, { target: { value: "Birthday board" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(screen.getByText("Birthday board")).toBeTruthy();
    expect(screen.getByText("Not saved yet")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Save to my scenes/ }));
    await screen.findByText("Scene limit reached");
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(String(init?.body)) as { name: string; scenes: { name: string }[] };
    expect(body.name).toBe("Birthday board");
    expect(body.scenes[0]?.name).toBe("Birthday board");
  });
});

describe("NewSceneWithAi bar", () => {
  it("collapses Save into a … menu when the bar has no room, keeping the display picker beside it", async () => {
    // Every element 120 wide; the bar ends at 500, the title at 400.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("editor-modal__bar")) {
        return { right: 500 } as DOMRect;
      }
      if (this.classList.contains("editor-modal__title")) {
        return { right: 400 } as DOMRect;
      }
      return { width: 120 } as DOMRect;
    });
    render(<NewSceneWithAi myScenesUrl="/scenes" />);
    await waitFor(() => expect(screen.getByTestId("editor")).toBeTruthy());
    expect(screen.queryByRole("button", { name: /Save to my scenes/ })).toBeNull();
    expect(screen.getByRole("combobox", { name: "Display size" })).toBeTruthy();
    const more = screen.getByRole("button", { name: "More actions" });
    expect(more.getAttribute("aria-haspopup")).toBe("menu");
    fireEvent.click(more);
    const item = within(screen.getByRole("menu")).getByRole("menuitem", { name: "Save to my scenes" });
    fireEvent.click(item);
    expect(screen.queryByRole("menu")).toBeNull();
    await screen.findByText("Scene limit reached");
  });

  it("shows one panel at a time on a narrow viewport, the Editor first", async () => {
    const listeners = new Set<() => void>();
    let narrow = true;
    vi.stubGlobal("matchMedia", (media: string) => ({
      addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
      get matches() {
        return media === "(max-width: 900px)" && narrow;
      },
      media,
      removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
    }));
    render(<NewSceneWithAi myScenesUrl="/scenes" />);
    await waitFor(() => expect(screen.getByTestId("editor")).toBeTruthy());
    const tabs = () =>
      within(screen.getByRole("tablist", { name: "Panels" }))
        .getAllByRole("tab")
        .map((tab) => `${tab.textContent}${tab.getAttribute("aria-selected") === "true" ? "*" : ""}`);
    // No Preview or Info in the set: the first of it, the Editor.
    expect(tabs()).toEqual(["Editor*", "AI", "Preview"]);
    expect(screen.queryByTestId("ai-panel")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "AI" }));
    expect(tabs()).toEqual(["Editor", "AI*", "Preview"]);
    expect(screen.getByTestId("ai-panel")).toBeTruthy();
    expect((document.querySelector(".editor-modal__editor") as HTMLElement).hidden).toBe(true);
    // Wide: the set (Editor + AI) side by side.
    narrow = false;
    act(() => listeners.forEach((listener) => listener()));
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.getByRole("button", { name: "AI" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Editor" }).getAttribute("aria-pressed")).toBe("true");
    expect((document.querySelector(".editor-modal__editor") as HTMLElement).hidden).toBe(false);
  });
});

describe("NewSceneWithAi drafts", () => {
  const draft: NewSceneDraft = {
    chat: {
      chatId: "chat-1",
      messages: [
        { content: "show a big pineapple", role: "user" },
        { content: "Made a bold, sunny pineapple.", role: "assistant" },
      ],
    },
    presetIndex: 1,
    savedAt: new Date().toISOString(),
    scenes: [{ id: "s1", name: "Pineapple", nodes: [], edges: [] }],
    selectedSceneId: "s1",
  };

  beforeEach(() => {
    window.localStorage.clear();
    window.location.hash = "";
  });

  it("keeps the unsaved scene in the browser, named by the URL hash", async () => {
    const { unmount } = render(<NewSceneWithAi myScenesUrl="/scenes" />);
    await waitFor(() => expect(screen.getByTestId("editor")).toBeTruthy());
    // A blank page that nobody touched leaves nothing behind.
    expect(window.location.hash).toBe("");

    fireEvent.click(screen.getByRole("button", { name: "Rename scene" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Scene name" }), {
      target: { value: "Pineapple" },
    });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Scene name" }), { key: "Enter" });
    // Unmounting flushes the debounced write, as a reload would.
    unmount();

    const draftId = window.location.hash.replace("#d=", "");
    expect(draftId).toMatch(/^[a-f0-9]+$/);
    expect(readNewSceneDraft(draftId)?.scenes[0]).toMatchObject({ name: "Pineapple" });
  });

  it("reopens the draft named by the hash instead of starting blank, and does not re-run ?prompt=", async () => {
    window.location.hash = "#d=abc123";
    window.localStorage.setItem(newSceneDraftKey("abc123"), JSON.stringify(draft));

    render(<NewSceneWithAi initialPrompt="show a big pineapple" myScenesUrl="/scenes" />);
    await waitFor(() => expect(screen.getByTestId("editor")).toBeTruthy());

    expect(screen.getByText("Pineapple")).toBeTruthy();
    expect(screen.getByText("Not saved yet")).toBeTruthy();
    expect((screen.getByRole("combobox", { name: "Display size" }) as HTMLSelectElement).value).toBe("1");
    const panel = screen.getByTestId("ai-panel");
    expect(panel.getAttribute("data-prompt")).toBe("");
    expect(panel.getAttribute("data-chat")).toBe("chat-1");
  });

  it("starts blank when the hash names a draft this browser does not have", async () => {
    window.location.hash = "#d=gone";
    render(<NewSceneWithAi initialPrompt="show a big pineapple" myScenesUrl="/scenes" />);
    await waitFor(() => expect(screen.getByTestId("editor")).toBeTruthy());
    expect(screen.getByText("New scene")).toBeTruthy();
    expect(screen.getByTestId("ai-panel").getAttribute("data-prompt")).toBe("show a big pineapple");
  });

  it("clears the draft once the scene is saved", async () => {
    window.location.hash = "#d=abc123";
    window.localStorage.setItem(newSceneDraftKey("abc123"), JSON.stringify(draft));
    fetchMock.mockImplementationOnce(async () => Response.json({ scene: { slug: "pineapple" } }));
    // jsdom refuses a real navigation; the assignment is all we need.
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, hash: "#d=abc123", href: "" },
    });

    render(<NewSceneWithAi myScenesUrl="/scenes" />);
    await waitFor(() => expect(screen.getByTestId("editor")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Save to my scenes/ }));

    await waitFor(() => expect(readNewSceneDraft("abc123")).toBeNull());
  });
});

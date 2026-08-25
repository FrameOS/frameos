// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EDITOR_RELOAD_DEBOUNCE_MS,
  normalizeHexColor,
  NOTICE_HIDE_MS,
  SceneLivePreviewPanel,
} from "./SceneLivePreview";

type PreviewCallbacks = {
  onReady?: (info: unknown) => void;
  onFrame?: (frame: { width: number; height: number; renderMs: number }) => void;
  onState?: (state: Record<string, unknown>) => void;
};

// The wasm runtime is a worker + emscripten bundle — not something jsdom can
// run. Stand in for FrameOSPreview, capture the options, and drive the
// callbacks by hand; the showIf helpers are the real ones.
const previews = vi.hoisted(
  () =>
    [] as Array<{
      options: PreviewCallbacks & { scenes: unknown[] };
      destroy: ReturnType<typeof vi.fn>;
      setSceneState: ReturnType<typeof vi.fn>;
      selectScene: ReturnType<typeof vi.fn>;
    }>,
);
vi.mock("frameos-wasm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("frameos-wasm")>()),
  FrameOSPreview: class {
    options: PreviewCallbacks & { scenes: unknown[] };
    sceneInfo = null;
    state = {};
    currentSceneId = null;
    destroy = vi.fn();
    render = vi.fn();
    sendEvent = vi.fn();
    setSceneState = vi.fn();
    selectScene = vi.fn();
    attachCanvas = vi.fn();
    constructor(options: PreviewCallbacks & { scenes: unknown[] }) {
      this.options = options;
      previews.push(this);
    }
  },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

const clockScene = {
  fields: [
    { access: "public", label: "Clock style", name: "style", options: ["station", "minimal"], type: "select", value: "station" },
    { access: "public", label: "Accent color", name: "accent", type: "color", value: "#d98a5a" },
    { access: "public", label: "Show date", name: "showDate", type: "boolean", value: true },
    { access: "private", name: "secret", type: "string", value: "hidden" },
  ],
  id: "scene-runtime-1",
  nodes: [],
};

const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.includes("/scenes.json")) {
    return Response.json([clockScene]);
  }
  if (url.includes("/api/settings")) {
    return Response.json({});
  }
  throw new Error(`Unexpected fetch: ${url}`);
});

const versions = [
  { createdAt: "2026-08-10T10:00:00.000Z", version: 1, yankedAt: null },
  { createdAt: "2026-08-20T10:00:00.000Z", version: 2, yankedAt: "2026-08-21T10:00:00.000Z" },
  { createdAt: "2026-08-24T10:00:00.000Z", version: 3, yankedAt: null },
];

function scenesJsonUrls() {
  return fetchMock.mock.calls
    .map(([input]) => String(input))
    .filter((url) => url.includes("/scenes.json"));
}

function sourceSelect() {
  return screen.getByRole("combobox", { name: "Preview source" }) as HTMLSelectElement;
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  previews.length = 0;
  fetchMock.mockClear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("SceneLivePreviewPanel screenshot gating", () => {
  it("keeps the screenshot buttons disabled until the runtime paints a frame", async () => {
    render(<SceneLivePreviewPanel sceneId="scene-1" />);
    await waitFor(() => expect(previews).toHaveLength(1));

    const saveButton = screen.getByRole("button", {
      name: /Download PNG/,
    }) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(true);
    expect(saveButton.title).toContain("first frame");

    const { options } = previews[0]!;
    expect(options.onFrame).toBeTypeOf("function");
    act(() => options.onFrame!({ height: 480, renderMs: 4, width: 800 }));

    expect(saveButton.disabled).toBe(false);
  });

  it("re-disables the button when the runtime is restarted", async () => {
    render(<SceneLivePreviewPanel sceneId="scene-1" />);
    await waitFor(() => expect(previews).toHaveLength(1));
    act(() => previews[0]!.options.onFrame!({ height: 480, renderMs: 4, width: 800 }));

    const saveButton = screen.getByRole("button", {
      name: /Download PNG/,
    }) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: /Restart/ }));
    await waitFor(() => expect(previews).toHaveLength(2));
    expect(previews[0]!.destroy).toHaveBeenCalled();
    expect(saveButton.disabled).toBe(true);
  });
});

// jsdom has no canvas: stand in for the 2d context and the PNG encodings
// (the download goes through toBlob + an object URL, the lightbox through
// toDataURL).
function stubCanvas() {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage: vi.fn(),
    fillRect: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (callback) {
    callback(new Blob(["png"], { type: "image/png" }));
  });
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,QUJD");
  Object.assign(URL, { createObjectURL: vi.fn(() => "blob:preview"), revokeObjectURL: vi.fn() });
}

describe("SceneLivePreviewPanel lightbox", () => {
  it("opens the frame at full size on a canvas click, toggles fit/1:1, and closes on Esc", async () => {
    render(<SceneLivePreviewPanel height={600} sceneId="scene-1" width={800} />);
    await waitFor(() => expect(previews).toHaveLength(1));
    const canvas = document.querySelector("canvas.live-preview__canvas") as HTMLCanvasElement;
    // Nothing to zoom into before the first frame.
    expect(canvas.classList.contains("live-preview__canvas--zoomable")).toBe(false);
    expect(canvas.getAttribute("role")).toBeNull();
    stubCanvas();
    fireEvent.click(canvas);
    expect(screen.queryByRole("dialog", { name: "Preview frame" })).toBeNull();

    act(() => previews[0]!.options.onFrame!({ height: 600, renderMs: 4, width: 800 }));
    expect(canvas.classList.contains("live-preview__canvas--zoomable")).toBe(true);
    expect(canvas.getAttribute("role")).toBe("button");
    fireEvent.click(canvas);
    const dialog = screen.getByRole("dialog", { name: "Preview frame" });
    // On <body>, outside the panel (the editor frame's transform would trap
    // a fixed overlay inside the column).
    expect(dialog.parentElement).toBe(document.body);
    const image = screen.getByRole("img", { name: "The rendered frame" }) as HTMLImageElement;
    // A data URL: the page's CSP allows data: images, not blob: ones.
    expect(image.getAttribute("src")).toBe("data:image/png;base64,QUJD");
    expect(image.classList.contains("lightbox__image--fit")).toBe(true);

    fireEvent.click(image);
    expect(image.classList.contains("lightbox__image--fit")).toBe(false);
    expect(screen.getByRole("dialog", { name: "Preview frame" })).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Preview frame" })).toBeNull();

    // The × and the backdrop close it too.
    fireEvent.click(canvas);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog", { name: "Preview frame" })).toBeNull();
    fireEvent.click(canvas);
    fireEvent.click(screen.getByRole("dialog", { name: "Preview frame" }));
    expect(screen.queryByRole("dialog", { name: "Preview frame" })).toBeNull();
    vi.restoreAllMocks();
  });
});

describe("SceneLivePreviewPanel notices", () => {
  it("shows 'Screenshot downloaded.' with an ×, and hides it on its own", async () => {
    render(<SceneLivePreviewPanel sceneId="scene-1" />);
    await waitFor(() => expect(previews).toHaveLength(1));
    act(() => previews[0]!.options.onFrame!({ height: 480, renderMs: 4, width: 800 }));

    stubCanvas();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    vi.useFakeTimers();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Download PNG/ }));
    });
    expect(click).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Screenshot downloaded.")).toBeTruthy();

    act(() => vi.advanceTimersByTime(NOTICE_HIDE_MS - 1));
    expect(screen.getByText("Screenshot downloaded.")).toBeTruthy();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByText("Screenshot downloaded.")).toBeNull();

    // The × takes it away at once.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Download PNG/ }));
    });
    expect(screen.getByText("Screenshot downloaded.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText("Screenshot downloaded.")).toBeNull();
    vi.restoreAllMocks();
  });
});

describe("SceneLivePreviewPanel viewport", () => {
  it("Rotate swaps width and height and reboots the runtime at once", async () => {
    render(<SceneLivePreviewPanel height={600} sceneId="scene-1" width={800} />);
    await waitFor(() => expect(previews).toHaveLength(1));
    const sized = (index: number) =>
      previews[index]!.options as unknown as { width: number; height: number };
    expect(sized(0)).toMatchObject({ height: 600, width: 800 });

    const rotate = screen.getByRole("button", { name: "Rotate" });
    expect(rotate.getAttribute("aria-label")).toBe("Rotate");
    expect(rotate.title).toBe("Swap width and height");
    fireEvent.click(rotate);
    await waitFor(() => expect(previews).toHaveLength(2));
    expect(previews[0]!.destroy).toHaveBeenCalled();
    expect(sized(1)).toMatchObject({ height: 800, width: 600 });
    expect((screen.getByLabelText("Resolution") as HTMLInputElement).value).toBe("600");
    expect((screen.getByLabelText("Viewport height") as HTMLInputElement).value).toBe("800");
    // The form matches the applied size, so Resize has nothing to do.
    expect((screen.getByRole("button", { name: "Resize" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("SceneLivePreviewPanel screenshot buttons", () => {
  it("offers Save to images only to the owner of a saved scene, Download to everyone", async () => {
    const { unmount } = render(<SceneLivePreviewPanel sceneId="scene-1" />);
    await waitFor(() => expect(previews).toHaveLength(1));
    expect(screen.queryByRole("button", { name: /Save to images/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Download PNG/ })).toBeTruthy();
    unmount();

    render(<SceneLivePreviewPanel canSaveToGallery sceneId="scene-1" />);
    await waitFor(() => expect(previews).toHaveLength(2));
    expect(screen.getByRole("button", { name: /Save to images/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Download PNG/ })).toBeTruthy();
    cleanup();

    // A scene that is not saved yet has no gallery to save into.
    render(<SceneLivePreviewPanel canSaveToGallery sceneId={null} scenes={[clockScene]} />);
    await waitFor(() => expect(previews).toHaveLength(3));
    expect(screen.queryByRole("button", { name: /Save to images/ })).toBeNull();
  });
});

describe("SceneLivePreviewPanel source selector", () => {
  it("runs the editor's scenes by default, and fetches a version on request", async () => {
    const editorScenes = [{ ...clockScene, id: "edited", name: "Edited" }];
    render(<SceneLivePreviewPanel sceneId="scene-1" scenes={editorScenes} versions={versions} />);
    await waitFor(() => expect(previews).toHaveLength(1));

    const select = sourceSelect();
    expect(Array.from(select.options).map((option) => option.textContent)).toEqual([
      "Editor (unsaved)",
      "v3 · 24 Aug 2026 · latest",
      "v2 · 20 Aug 2026 · unpublished",
      "v1 · 10 Aug 2026",
    ]);
    expect(select.value).toBe("editor");
    // The editor's scenes go straight to the runtime: nothing to fetch.
    expect(scenesJsonUrls()).toEqual([]);
    expect(previews[0]!.options.scenes).toBe(editorScenes);

    fireEvent.change(select, { target: { value: "1" } });
    await waitFor(() =>
      expect(scenesJsonUrls()).toEqual(["/api/store/scenes/scene-1/scenes.json?version=1"]),
    );
    // The old runtime is torn down and a new one boots with the fetched scenes.
    await waitFor(() => expect(previews).toHaveLength(2));
    expect(previews[0]!.destroy).toHaveBeenCalled();
    expect(previews[1]!.options.scenes).toEqual([clockScene]);
    expect(select.value).toBe("1");

    // Back to the editor: its scenes are still at hand, no fetch.
    fireEvent.change(select, { target: { value: "editor" } });
    await waitFor(() => expect(previews).toHaveLength(3));
    expect(previews[2]!.options.scenes).toBe(editorScenes);
    expect(scenesJsonUrls()).toHaveLength(1);
  });

  it("starts on the pinned version when asked to, keeping the share token in the URL", async () => {
    render(
      <SceneLivePreviewPanel
        initialSource="version"
        pinnedVersion={2}
        sceneId="scene-1"
        scenes={[clockScene]}
        share="tok"
        versions={versions}
      />,
    );
    await waitFor(() => expect(previews).toHaveLength(1));

    expect(sourceSelect().value).toBe("2");
    expect(scenesJsonUrls()).toEqual([
      "/api/store/scenes/scene-1/scenes.json?version=2&share=tok",
    ]);
  });

  it("defaults to the latest published version when there is no editor to preview", async () => {
    render(<SceneLivePreviewPanel sceneId="scene-1" versions={versions} />);
    await waitFor(() => expect(previews).toHaveLength(1));
    expect(sourceSelect().value).toBe("3");
    expect(scenesJsonUrls()).toEqual(["/api/store/scenes/scene-1/scenes.json?version=3"]);
  });

  it("fetches without ?version= when no version list is known", async () => {
    render(<SceneLivePreviewPanel sceneId="scene-1" />);
    await waitFor(() => expect(previews).toHaveLength(1));
    expect(sourceSelect().disabled).toBe(true);
    expect(scenesJsonUrls()).toEqual(["/api/store/scenes/scene-1/scenes.json"]);
  });

  it("only offers the editor for a scene that is not saved yet", async () => {
    render(<SceneLivePreviewPanel sceneId={null} scenes={[clockScene]} />);
    await waitFor(() => expect(previews).toHaveLength(1));
    const select = sourceSelect();
    expect(Array.from(select.options).map((option) => option.value)).toEqual(["editor"]);
    expect(select.disabled).toBe(true);
    expect(scenesJsonUrls()).toEqual([]);
  });
});

describe("SceneLivePreviewPanel editor reloads", () => {
  it("reboots the runtime after a quiet period when the editor's scenes change, not on identical payloads", async () => {
    const { rerender } = render(
      <SceneLivePreviewPanel sceneId={null} scenes={[clockScene]} />,
    );
    await waitFor(() => expect(previews).toHaveLength(1));
    vi.useFakeTimers();

    // Same content, new array identity (the editor reports after every
    // edit, layout moves included): nothing happens.
    rerender(<SceneLivePreviewPanel sceneId={null} scenes={[{ ...clockScene }]} />);
    act(() => vi.advanceTimersByTime(EDITOR_RELOAD_DEBOUNCE_MS + 50));
    expect(previews).toHaveLength(1);

    const changed = [{ ...clockScene, name: "Renamed" }];
    rerender(<SceneLivePreviewPanel sceneId={null} scenes={changed} />);
    act(() => vi.advanceTimersByTime(EDITOR_RELOAD_DEBOUNCE_MS - 100));
    expect(previews).toHaveLength(1);
    // Another edit inside the window restarts the clock.
    const changedAgain = [{ ...clockScene, name: "Renamed twice" }];
    rerender(<SceneLivePreviewPanel sceneId={null} scenes={changedAgain} />);
    act(() => vi.advanceTimersByTime(EDITOR_RELOAD_DEBOUNCE_MS - 100));
    expect(previews).toHaveLength(1);
    act(() => vi.advanceTimersByTime(200));
    expect(previews).toHaveLength(2);
    expect(previews[0]!.destroy).toHaveBeenCalled();
    expect(previews[1]!.options.scenes).toBe(changedAgain);
  });

  it("keeps typed and applied field values across a reload while the fields still exist", async () => {
    const { rerender } = render(
      <SceneLivePreviewPanel sceneId={null} scenes={[clockScene]} />,
    );
    await waitFor(() => expect(previews).toHaveLength(1));
    act(() =>
      previews[0]!.options.onReady!({
        currentSceneId: "scene-runtime-1",
        scenes: [{ id: "scene-runtime-1", name: "Clock", refreshInterval: 60 }],
      }),
    );
    // Applied: the style. Typed but not applied: the accent.
    fireEvent.change(screen.getByLabelText("Clock style"), { target: { value: "minimal" } });
    fireEvent.click(screen.getByRole("button", { name: /Apply & render/ }));
    expect(previews[0]!.setSceneState).toHaveBeenCalledWith({
      accent: "#d98a5a",
      showDate: true,
      style: "minimal",
    });
    fireEvent.change(screen.getByLabelText("Accent color"), { target: { value: "#112233" } });

    vi.useFakeTimers();
    // The editor drops the "Show date" field and keeps the rest.
    const reloaded = [
      { ...clockScene, fields: clockScene.fields.filter((field) => field.name !== "showDate") },
    ];
    rerender(<SceneLivePreviewPanel sceneId={null} scenes={reloaded} />);
    act(() => vi.advanceTimersByTime(EDITOR_RELOAD_DEBOUNCE_MS + 50));
    expect(previews).toHaveLength(2);
    vi.useRealTimers();

    // The form still shows what was being tried out…
    expect((screen.getByLabelText("Clock style") as HTMLSelectElement).value).toBe("minimal");
    expect((screen.getByLabelText("Accent color") as HTMLInputElement).value).toBe("#112233");
    expect(screen.queryByRole("checkbox")).toBeNull();
    // …and the applied values are replayed into the fresh runtime, minus
    // the field that no longer exists.
    act(() =>
      previews[1]!.options.onReady!({
        currentSceneId: "scene-runtime-1",
        scenes: [{ id: "scene-runtime-1", name: "Clock", refreshInterval: 60 }],
      }),
    );
    expect(previews[1]!.setSceneState).toHaveBeenCalledWith({
      accent: "#d98a5a",
      style: "minimal",
    });
  });

  it("shows the scene selected in the editor rather than the default one", async () => {
    const scenes = [
      { ...clockScene, default: true },
      { fields: [], id: "second", name: "Second", nodes: [] },
    ];
    const { rerender } = render(
      <SceneLivePreviewPanel editorSceneId="second" sceneId={null} scenes={scenes} />,
    );
    await waitFor(() => expect(previews).toHaveLength(1));
    act(() =>
      previews[0]!.options.onReady!({
        currentSceneId: "scene-runtime-1",
        scenes: [
          { id: "scene-runtime-1", name: "Clock", refreshInterval: 60 },
          { id: "second", name: "Second", refreshInterval: 60 },
        ],
      }),
    );
    expect(previews[0]!.selectScene).toHaveBeenCalledWith("second");
    const sceneSelect = screen.getByRole("combobox", { name: "Scene" }) as HTMLSelectElement;
    expect(sceneSelect.value).toBe("second");

    // Switching scenes in the editor follows along without a reboot.
    rerender(
      <SceneLivePreviewPanel editorSceneId="scene-runtime-1" sceneId={null} scenes={scenes} />,
    );
    expect(previews).toHaveLength(1);
    expect(previews[0]!.selectScene).toHaveBeenLastCalledWith("scene-runtime-1");
    expect(sceneSelect.value).toBe("scene-runtime-1");
  });
});

describe("SceneLivePreviewPanel state-field form", () => {
  async function openWithFields() {
    render(<SceneLivePreviewPanel sceneId="scene-1" />);
    await waitFor(() => expect(previews).toHaveLength(1));
    // Fields render from scenes.json straight away; the actions wait for the
    // runtime to report ready.
    act(() =>
      previews[0]!.options.onReady!({
        currentSceneId: "scene-runtime-1",
        scenes: [{ id: "scene-runtime-1", name: "Clock", refreshInterval: 60 }],
      }),
    );
  }

  it("keeps the actions in a sticky toolbar above the form and flags unapplied edits", async () => {
    await openWithFields();

    const apply = screen.getByRole("button", { name: /Apply & render/ });
    const toolbar = apply.closest(".live-preview-panel__toolbar");
    expect(toolbar).toBeTruthy();
    expect(toolbar!.closest(".live-preview-panel__header")).toBeTruthy();
    // The toolbar precedes the form in the document (top of the column).
    const form = document.querySelector(".live-preview__form")!;
    expect(toolbar!.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByText("unapplied changes")).toBeNull();

    fireEvent.change(screen.getByLabelText("Clock style"), { target: { value: "minimal" } });
    expect(screen.getByText("unapplied changes")).toBeTruthy();

    fireEvent.click(apply);
    // Still pending until the runtime confirms the new state…
    expect(screen.getByText("unapplied changes")).toBeTruthy();
    act(() =>
      previews[0]!.options.onState!({ accent: "#d98a5a", showDate: true, style: "minimal" }),
    );
    expect(screen.queryByText("unapplied changes")).toBeNull();
  });

  it("renders a colour field as a swatch plus hex text, kept in sync both ways", async () => {
    await openWithFields();

    const hex = screen.getByLabelText("Accent color") as HTMLInputElement;
    const swatch = screen.getByLabelText("Accent color swatch") as HTMLInputElement;
    expect(hex.type).toBe("text");
    expect(hex.value).toBe("#d98a5a");
    expect(swatch.type).toBe("color");
    expect(swatch.value).toBe("#d98a5a");

    fireEvent.change(swatch, { target: { value: "#112233" } });
    expect(hex.value).toBe("#112233");
    expect(swatch.value).toBe("#112233");

    fireEvent.change(hex, { target: { value: "#ABC" } });
    expect(hex.value).toBe("#ABC");
    expect(swatch.value).toBe("#aabbcc");

    // Apply sends the typed text for the runtime to interpret.
    fireEvent.click(screen.getByRole("button", { name: /Apply & render/ }));
    expect(previews[0]!.setSceneState).toHaveBeenCalledWith({
      accent: "#ABC",
      showDate: true,
      style: "station",
    });
  });

  it("shows public fields only, booleans as checkboxes, and keeps unapplied edits across state reports", async () => {
    await openWithFields();

    expect(screen.queryByLabelText("secret")).toBeNull();
    const style = screen.getByLabelText("Clock style") as HTMLSelectElement;
    expect(style.value).toBe("station");
    const showDate = screen.getByRole("checkbox") as HTMLInputElement;
    expect(showDate.checked).toBe(true);

    fireEvent.change(style, { target: { value: "minimal" } });
    fireEvent.click(showDate);
    // A state report that does not include the edits leaves them in place…
    act(() =>
      previews[0]!.options.onState!({ accent: "#d98a5a", showDate: true, style: "station" }),
    );
    expect(style.value).toBe("minimal");
    expect(showDate.checked).toBe(false);
    // …and one that confirms them clears the overrides without changing the view.
    act(() =>
      previews[0]!.options.onState!({ accent: "#d98a5a", showDate: false, style: "minimal" }),
    );
    expect(style.value).toBe("minimal");
    expect(showDate.checked).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: /Reset/ }));
    expect(style.value).toBe("station");
    expect(showDate.checked).toBe(true);
    expect(previews[0]!.setSceneState).toHaveBeenLastCalledWith({
      accent: "#d98a5a",
      showDate: true,
      style: "station",
    });
  });
});

describe("normalizeHexColor", () => {
  it("accepts short and long hex, rejects everything else", () => {
    expect(normalizeHexColor("#AaBbCc")).toBe("#aabbcc");
    expect(normalizeHexColor(" #fff ")).toBe("#ffffff");
    expect(normalizeHexColor("white")).toBeNull();
    expect(normalizeHexColor("#12345")).toBeNull();
    expect(normalizeHexColor("")).toBeNull();
  });
});

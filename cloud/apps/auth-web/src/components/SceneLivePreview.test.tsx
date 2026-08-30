// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTO_APPLY_DEBOUNCE_MS,
  EDITOR_RELOAD_DEBOUNCE_MS,
  measureFps,
  normalizeHexColor,
  NOTICE_HIDE_MS,
  SceneLivePreviewPanel,
} from "./SceneLivePreview";

type PreviewCallbacks = {
  onReady?: (info: unknown) => void;
  onFrame?: (frame: { width: number; height: number; renderMs: number }) => void;
  onState?: (state: Record<string, unknown>) => void;
  onLog?: (message: string) => void;
  onFastRenderRequest?: (intervalMs: number) => void;
  onAssetsChanged?: () => void;
  fastMode?: boolean;
  panelPalette?: string | null;
  deviceLimits?: {
    availableRenderBytes: number;
    jsMemoryLimitMb: number;
    jsMaxStackKb: number;
    maxHttpResponseBytes: number;
  } | null;
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
      setFastMode: ReturnType<typeof vi.fn>;
      setPanelPalette: ReturnType<typeof vi.fn>;
      render: ReturnType<typeof vi.fn>;
      listAssets: ReturnType<typeof vi.fn>;
      deleteAsset: ReturnType<typeof vi.fn>;
      writeAsset: ReturnType<typeof vi.fn>;
    }>,
);
// What the fake runtime's browser folder holds; tests replace it.
const fakeAssets = vi.hoisted(() => ({
  entries: [] as Array<{ path: string; size: number; mtime: number; isDir: boolean }>,
}));
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
    setFastMode = vi.fn();
    setPanelPalette = vi.fn();
    assetsInfo = { mounted: true, persistent: true, root: "/srv/assets", maxBytes: 128 * 1024 * 1024 };
    listAssets = vi.fn(async () => fakeAssets.entries);
    readAsset = vi.fn(async () => new ArrayBuffer(4));
    writeAsset = vi.fn(async () => {});
    createAssetFolder = vi.fn(async () => {});
    deleteAsset = vi.fn(async () => {});
    resetAssets = vi.fn(async () => {});
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

function scenesJsonUrls() {
  return fetchMock.mock.calls
    .map(([input]) => String(input))
    .filter((url) => url.includes("/scenes.json"));
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  previews.length = 0;
  fakeAssets.entries = [];
  fetchMock.mockClear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  window.localStorage.clear();
});

describe("SceneLivePreviewPanel screenshot gating", () => {
  it("keeps the screenshot buttons disabled until the runtime paints a frame", async () => {
    render(<SceneLivePreviewPanel sceneId="scene-1" scenes={[clockScene]} />);
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
    render(<SceneLivePreviewPanel sceneId="scene-1" scenes={[clockScene]} />);
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
    render(<SceneLivePreviewPanel height={600} sceneId="scene-1" scenes={[clockScene]} width={800} />);
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
    // Live: a canvas the runtime's frames are mirrored into, not a still.
    const image = screen.getByRole("img", { name: "The rendered frame" });
    expect(image.tagName).toBe("CANVAS");
    const context = HTMLCanvasElement.prototype.getContext("2d") as unknown as { drawImage: ReturnType<typeof vi.fn> };
    const paintsBefore = context.drawImage.mock.calls.length;
    act(() => previews[0]!.options.onFrame!({ height: 600, renderMs: 4, width: 800 }));
    expect(context.drawImage.mock.calls.length).toBeGreaterThan(paintsBefore);
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
    render(<SceneLivePreviewPanel sceneId="scene-1" scenes={[clockScene]} />);
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
    render(<SceneLivePreviewPanel height={600} sceneId="scene-1" scenes={[clockScene]} width={800} />);
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
    const { unmount } = render(<SceneLivePreviewPanel sceneId="scene-1" scenes={[clockScene]} />);
    await waitFor(() => expect(previews).toHaveLength(1));
    expect(screen.queryByRole("button", { name: /Save to images/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Download PNG/ })).toBeTruthy();
    unmount();

    render(<SceneLivePreviewPanel canSaveToGallery sceneId="scene-1" scenes={[clockScene]} />);
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

describe("SceneLivePreviewPanel source", () => {
  it("runs the editor's scenes as they are handed to it — there is no source to pick", async () => {
    const editorScenes = [{ ...clockScene, id: "edited", name: "Edited" }];
    render(<SceneLivePreviewPanel sceneId="scene-1" scenes={editorScenes} />);
    await waitFor(() => expect(previews).toHaveLength(1));
    expect(previews[0]!.options.scenes).toBe(editorScenes);
    // The editor's scenes go straight to the runtime: nothing to fetch, and
    // no dropdown of published versions (the bar's, in the workspace, loads
    // a version into the editor instead).
    expect(scenesJsonUrls()).toEqual([]);
    expect(screen.queryByRole("combobox", { name: "Preview source" })).toBeNull();
    expect(screen.queryByText("Source")).toBeNull();
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
    // The "Show date" box is gone (the "Auto apply" one is the toolbar's).
    expect(screen.queryByRole("checkbox", { name: /^(Yes|No)$/ })).toBeNull();
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
    render(<SceneLivePreviewPanel sceneId="scene-1" scenes={[clockScene]} />);
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
    // Pending edits show as the button turning primary — nothing appears or
    // disappears in the layout, so the form below never jumps.
    expect(apply.className).toContain("button--subtle");
    expect(apply.className).not.toContain("button-primary");

    fireEvent.change(screen.getByLabelText("Clock style"), { target: { value: "minimal" } });
    expect(apply.className).toContain("button-primary");

    fireEvent.click(apply);
    // Still pending until the runtime confirms the new state…
    expect(apply.className).toContain("button-primary");
    act(() =>
      previews[0]!.options.onState!({ accent: "#d98a5a", showDate: true, style: "minimal" }),
    );
    expect(apply.className).toContain("button--subtle");
    expect(apply.className).not.toContain("button-primary");
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
    // The boolean's checkbox is labelled by its Yes/No caption.
    const showDate = screen.getByRole("checkbox", { name: /^(Yes|No)$/ }) as HTMLInputElement;
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

describe("SceneLivePreviewPanel auto apply", () => {
  it("applies and renders on its own, debounced, once the box is ticked", async () => {
    render(<SceneLivePreviewPanel sceneId="scene-1" scenes={[clockScene]} />);
    await waitFor(() => expect(previews).toHaveLength(1));
    act(() =>
      previews[0]!.options.onReady!({
        currentSceneId: "scene-runtime-1",
        scenes: [{ id: "scene-runtime-1", name: "Clock", refreshInterval: 60 }],
      }),
    );
    vi.useFakeTimers();
    const style = screen.getByLabelText("Clock style");
    const setSceneState = previews[0]!.setSceneState;

    // Off by default: an edit waits for "Apply & render".
    fireEvent.change(style, { target: { value: "minimal" } });
    act(() => vi.advanceTimersByTime(AUTO_APPLY_DEBOUNCE_MS + 50));
    expect(setSceneState).not.toHaveBeenCalled();

    // Ticking it applies what is pending, then every later change.
    fireEvent.click(screen.getByRole("checkbox", { name: "Auto apply" }));
    act(() => vi.advanceTimersByTime(AUTO_APPLY_DEBOUNCE_MS + 50));
    expect(setSceneState).toHaveBeenCalledTimes(1);
    expect(setSceneState).toHaveBeenLastCalledWith({
      accent: "#d98a5a",
      showDate: true,
      style: "minimal",
    });
    act(() =>
      previews[0]!.options.onState!({ accent: "#d98a5a", showDate: true, style: "minimal" }),
    );

    // A burst of typing is one render, after the pause.
    const hex = screen.getByLabelText("Accent color");
    fireEvent.change(hex, { target: { value: "#1" } });
    act(() => vi.advanceTimersByTime(AUTO_APPLY_DEBOUNCE_MS - 100));
    fireEvent.change(hex, { target: { value: "#112233" } });
    act(() => vi.advanceTimersByTime(AUTO_APPLY_DEBOUNCE_MS - 100));
    expect(setSceneState).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(200));
    expect(setSceneState).toHaveBeenCalledTimes(2);
    expect(setSceneState).toHaveBeenLastCalledWith({
      accent: "#112233",
      showDate: true,
      style: "minimal",
    });
    // Confirmed by the runtime: nothing pending, nothing re-sent.
    act(() =>
      previews[0]!.options.onState!({ accent: "#112233", showDate: true, style: "minimal" }),
    );
    act(() => vi.advanceTimersByTime(AUTO_APPLY_DEBOUNCE_MS + 50));
    expect(setSceneState).toHaveBeenCalledTimes(2);
    expect(window.localStorage.getItem("frameos.preview.autoApply")).toBe("1");
  });
});

describe("SceneLivePreviewPanel panel dither", () => {
  async function open() {
    render(<SceneLivePreviewPanel sceneId="scene-1" scenes={[clockScene]} />);
    await waitFor(() => expect(previews).toHaveLength(1));
    act(() =>
      previews[0]!.options.onReady!({
        currentSceneId: "scene-runtime-1",
        scenes: [{ id: "scene-runtime-1", name: "Clock", refreshInterval: 60 }],
      }),
    );
  }

  it("is off by default, with the panel picker inert until it is on", async () => {
    await open();

    const dither = screen.getByRole("checkbox", { name: "Dither" }) as HTMLInputElement;
    const picker = screen.getByRole("combobox", {
      name: "Panel to simulate",
    }) as HTMLSelectElement;
    expect(dither.checked).toBe(false);
    expect(picker.disabled).toBe(true);
    expect(previews[0]!.options.panelPalette ?? null).toBeNull();
  });

  it("shows the frame through a panel, remembers it, and repaints without re-rendering", async () => {
    await open();

    fireEvent.click(screen.getByRole("checkbox", { name: "Dither" }));
    const picker = screen.getByRole("combobox", {
      name: "Panel to simulate",
    }) as HTMLSelectElement;
    expect(picker.disabled).toBe(false);
    // The checkbox alone picks a panel — the newest colour e-ink.
    expect(picker.value).toBe("spectra6");
    expect(previews[0]!.setPanelPalette).toHaveBeenLastCalledWith("spectra6");

    fireEvent.change(picker, { target: { value: "fourGray" } });
    expect(previews[0]!.setPanelPalette).toHaveBeenLastCalledWith("fourGray");
    // Repainted from the frame already in hand: no re-render was asked for.
    expect(previews[0]!.render).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("frameos.preview.panel")).toBe("fourGray");

    fireEvent.click(screen.getByRole("checkbox", { name: "Dither" }));
    expect(previews[0]!.setPanelPalette).toHaveBeenLastCalledWith(null);
    expect(window.localStorage.getItem("frameos.preview.panel")).toBe("");
  });

  it("boots a restarted runtime through the panel it was left on", async () => {
    window.localStorage.setItem("frameos.preview.panel", "blackWhite");
    await open();

    expect(
      (screen.getByRole("checkbox", { name: "Dither" }) as HTMLInputElement).checked,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    await waitFor(() => expect(previews).toHaveLength(2));
    expect(previews[1]!.options.panelPalette).toBe("blackWhite");
  });
});

describe("SceneLivePreviewPanel device simulation", () => {
  async function open(onDevicePresetChange?: (key: string) => void) {
    render(
      <SceneLivePreviewPanel
        onDevicePresetChange={onDevicePresetChange}
        sceneId="scene-1"
        scenes={[clockScene]}
      />,
    );
    await waitFor(() => expect(previews).toHaveLength(1));
    act(() =>
      previews[0]!.options.onReady!({
        currentSceneId: "scene-runtime-1",
        scenes: [{ id: "scene-runtime-1", name: "Clock", refreshInterval: 60 }],
      }),
    );
  }

  it("runs without limits by default", async () => {
    await open();
    expect(
      (screen.getByRole("combobox", { name: "Device to simulate" }) as HTMLSelectElement).value,
    ).toBe("browser");
    expect(previews[0]!.options.deviceLimits ?? null).toBeNull();
  });

  it("reboots the runtime under the chosen device's limits, remembers it, and tells the workspace", async () => {
    const onChange = vi.fn();
    await open(onChange);

    fireEvent.change(screen.getByRole("combobox", { name: "Device to simulate" }), {
      target: { value: "esp32" },
    });
    // Unlike Dither, the device changes what the runtime can do: a reboot.
    await waitFor(() => expect(previews).toHaveLength(2));
    const limits = previews[1]!.options.deviceLimits!;
    // The firmware math for an 8 MB board at the default 800×480: a few MB
    // of render memory, the ESP32's JS heap/stack and HTTP ceilings.
    expect(limits.availableRenderBytes).toBeGreaterThan(2 * 1024 * 1024);
    expect(limits.availableRenderBytes).toBeLessThan(6 * 1024 * 1024);
    expect(limits.jsMemoryLimitMb).toBe(4);
    expect(limits.jsMaxStackKb).toBe(20);
    expect(limits.maxHttpResponseBytes).toBe(6 * 1024 * 1024);
    expect(window.localStorage.getItem("frameos.preview.device")).toBe("esp32");
    expect(onChange).toHaveBeenLastCalledWith("esp32");
  });

  it("boots straight into the device it was left on, and reports it to the workspace", async () => {
    window.localStorage.setItem("frameos.preview.device", "piZero");
    const onChange = vi.fn();
    await open(onChange);

    expect(
      (screen.getByRole("combobox", { name: "Device to simulate" }) as HTMLSelectElement).value,
    ).toBe("piZero");
    expect(previews[0]!.options.deviceLimits?.availableRenderBytes).toBe(256 * 1024 * 1024);
    expect(onChange).toHaveBeenCalledWith("piZero");
  });

  it("flags a degraded render while it is on screen, and clears once a full render lands", async () => {
    window.localStorage.setItem("frameos.preview.device", "esp32");
    await open();

    const log = (line: string) => act(() => previews[0]!.options.onLog!(line));
    log(JSON.stringify({ event: "render:scene", height: 480, width: 800 }));
    log(JSON.stringify({ divisor: 2, event: "render:degraded" }));
    expect(screen.getByRole("status").textContent).toContain("1/2 size");

    log(JSON.stringify({ event: "render:scene", height: 480, width: 800 }));
    log(JSON.stringify({ event: "render:done", ms: 12 }));
    expect(screen.queryByText(/ran low on memory/)).toBeNull();
  });
});

describe("SceneLivePreviewPanel paid scenes", () => {
  // OpenAI bills per request; a render is one.
  const openAiScene = {
    ...clockScene,
    nodes: [{ data: { keyword: "data/openaiText" }, id: "n1", type: "app" }],
  };

  it("never renders on its own: the runtime only boots after Run preview, and a scene change gates it again", async () => {
    window.localStorage.setItem("frameos.preview.autoApply", "1");
    const { rerender } = render(
      <SceneLivePreviewPanel sceneId="scene-1" scenes={[openAiScene]} />,
    );
    // The settings fetch has settled once the form shows the OpenAI group;
    // still no runtime.
    await screen.findByText("OpenAI");
    expect(screen.getByRole("status", { name: "" }).textContent).toContain("OpenAI");
    expect(screen.getByText(/bills per request/)).toBeTruthy();
    expect(previews).toHaveLength(0);
    // Auto apply is not on offer, however it was remembered.
    expect(screen.queryByRole("checkbox", { name: "Auto apply" })).toBeNull();
    expect((screen.getByRole("button", { name: "Restart" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: /Run preview/ }));
    await waitFor(() => expect(previews).toHaveLength(1));
    expect(screen.queryByText(/bills per request/)).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "Auto apply" })).toBeNull();

    // An editor change takes the go-ahead back instead of re-rendering.
    vi.useFakeTimers();
    rerender(
      <SceneLivePreviewPanel sceneId="scene-1" scenes={[{ ...openAiScene, name: "Edited" }]} />,
    );
    act(() => vi.advanceTimersByTime(EDITOR_RELOAD_DEBOUNCE_MS + 50));
    vi.useRealTimers();
    expect(previews).toHaveLength(1);
    expect(previews[0]!.destroy).toHaveBeenCalled();
    expect(screen.getByText(/bills per request/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Run preview/ }));
    await waitFor(() => expect(previews).toHaveLength(2));
  });

  it("links the credentials hint to the account settings page", async () => {
    render(
      <SceneLivePreviewPanel
        sceneId="scene-1"
        scenes={[openAiScene]}
        settingsUrl="https://cloud.example/frames/settings#settings-openai"
      />,
    );
    const link = (await screen.findByRole("link", { name: "account settings" })) as HTMLAnchorElement;
    expect(link.href).toBe("https://cloud.example/frames/settings#settings-openai");
    expect(link.target).toBe("_blank");
  });

  it("collapses a credentials group whose key is saved on the account, until 'Use another key'", async () => {
    fetchMock.mockImplementationOnce(async () => Response.json({ openAI: { apiKey: "sk-stored" } }));
    render(<SceneLivePreviewPanel sceneId="scene-1" scenes={[openAiScene]} />);
    await screen.findByText("This scene uses keys saved in your account");
    expect(screen.getByText(/API key from your account/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Apply & reload preview/ })).toBeNull();
    expect(screen.queryByLabelText("API key")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Use another key" }));
    expect(screen.getByText("This scene uses services that need credentials")).toBeTruthy();
    expect(screen.getByLabelText("API key")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Apply & reload preview/ })).toBeTruthy();
  });

  it("offers auto apply for a scene without paid services", async () => {
    render(<SceneLivePreviewPanel sceneId="scene-1" scenes={[clockScene]} />);
    await waitFor(() => expect(previews).toHaveLength(1));
    expect(screen.queryByText(/bills per request/)).toBeNull();
    expect(screen.getByRole("checkbox", { name: "Auto apply" })).toBeTruthy();
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

describe("SceneLivePreviewPanel render pacing", () => {
  it("asks before letting a fast scene render faster than 1 fps, and keeps the answer across restarts", async () => {
    render(<SceneLivePreviewPanel sceneId="scene-1" scenes={[clockScene]} />);
    await waitFor(() => expect(previews).toHaveLength(1));
    // Throttled by default: no prompt, no toggle.
    expect(previews[0]!.options.fastMode).toBe(false);
    expect(screen.queryByText(/wants to render/)).toBeNull();
    expect(screen.queryByLabelText(/Real-time rendering/)).toBeNull();

    act(() => previews[0]!.options.onFastRenderRequest!(42));
    expect(screen.getByText(/every 42 ms \(about 24 times a second\)/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Run at full speed" }));
    expect(previews[0]!.setFastMode).toHaveBeenCalledWith(true);
    // The prompt turns into a toggle.
    expect(screen.queryByRole("button", { name: "Run at full speed" })).toBeNull();
    const toggle = screen.getByLabelText(/Real-time rendering/) as HTMLInputElement;
    expect(toggle.checked).toBe(true);

    // A restart boots the new runtime unthrottled, and its repeated request
    // does not bring the prompt back.
    fireEvent.click(screen.getByRole("button", { name: /Restart/ }));
    await waitFor(() => expect(previews).toHaveLength(2));
    expect(previews[1]!.options.fastMode).toBe(true);
    act(() => previews[1]!.options.onFastRenderRequest!(42));
    expect(screen.queryByRole("button", { name: "Run at full speed" })).toBeNull();

    fireEvent.click(toggle);
    expect(previews[1]!.setFastMode).toHaveBeenCalledWith(false);
    expect((screen.getByLabelText(/Real-time rendering/) as HTMLInputElement).checked).toBe(false);
    // Off: what the scene asks for, without doubled brackets.
    expect(screen.getByText(/Real-time rendering \(the scene asks for ~24 fps\)/)).toBeTruthy();
  });

  it("shows the measured frame rate on the toggle while rendering at full speed", async () => {
    render(<SceneLivePreviewPanel sceneId="scene-1" scenes={[clockScene]} />);
    await waitFor(() => expect(previews).toHaveLength(1));
    act(() => previews[0]!.options.onFastRenderRequest!(42));
    fireEvent.click(screen.getByRole("button", { name: "Run at full speed" }));
    const now = vi.spyOn(performance, "now");
    let clock = 1000;
    now.mockImplementation(() => clock);
    for (let i = 0; i < 6; i++) {
      act(() => previews[0]!.options.onFrame!({ height: 480, renderMs: 4, width: 800 }));
      clock += 50; // 20 fps
    }
    // The figure is published with the batched status update.
    await waitFor(() => expect(screen.getByText(/Real-time rendering · 20 fps/)).toBeTruthy());
    now.mockRestore();
  });

  it("measureFps averages the last arrivals", () => {
    expect(measureFps([])).toBeNull();
    expect(measureFps([10])).toBeNull();
    expect(measureFps([0, 100])).toBe(10);
    expect(measureFps([0, 50, 100, 150, 200, 250])).toBe(20);
    expect(measureFps([5, 5])).toBeNull();
  });

  it("'Keep 1 fps' dismisses the prompt but leaves the toggle to change one's mind", async () => {
    render(<SceneLivePreviewPanel sceneId="scene-1" scenes={[clockScene]} />);
    await waitFor(() => expect(previews).toHaveLength(1));
    act(() => previews[0]!.options.onFastRenderRequest!(100));
    fireEvent.click(screen.getByRole("button", { name: "Keep 1 fps" }));
    expect(previews[0]!.setFastMode).toHaveBeenCalledWith(false);
    expect(screen.queryByText(/wants to render/)).toBeNull();
    expect((screen.getByLabelText(/Real-time rendering/) as HTMLInputElement).checked).toBe(false);
  });
});

describe("SceneLivePreviewPanel browser assets", () => {
  it("lists the runtime's browser folder in a dialog, explains where it lives, and deletes on confirmation", async () => {
    fakeAssets.entries = [
      { isDir: true, mtime: 0, path: "photos", size: 0 },
      { isDir: false, mtime: 1_700_000_000_000, path: "photos/beach.jpg", size: 2048 },
      { isDir: false, mtime: 1_700_000_000_000, path: "sample-sunset.jpg", size: 300 * 1024 },
    ];
    Object.assign(URL, { createObjectURL: vi.fn(() => "blob:thumb"), revokeObjectURL: vi.fn() });
    render(<SceneLivePreviewPanel sceneId="scene-1" scenes={[clockScene]} />);
    await waitFor(() => expect(previews).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: /Browser assets/ }));
    const dialog = screen.getByRole("dialog", { name: "Browser assets" });
    expect(dialog.parentElement).toBe(document.body);
    expect(dialog.textContent).toContain("only in this browser");
    expect(dialog.textContent).toContain("/srv/assets");
    await waitFor(() => expect(previews[0]!.listAssets).toHaveBeenCalled());
    // Root: the folder and the root file, not the nested one.
    await waitFor(() => expect(screen.getByText("sample-sunset.jpg")).toBeTruthy());
    expect(screen.getByText("photos/")).toBeTruthy();
    expect(screen.queryByText("beach.jpg")).toBeNull();
    expect(dialog.textContent).toContain("2 files, 302 KB of 128.0 MB");

    // Into the folder, and back via the breadcrumb.
    fireEvent.click(screen.getByRole("button", { name: "photos/" }));
    expect(screen.getByText("beach.jpg")).toBeTruthy();
    expect(screen.queryByText("sample-sunset.jpg")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "/srv/assets" }));
    expect(screen.getByText("sample-sunset.jpg")).toBeTruthy();

    // Delete asks first, then goes through the runtime.
    fireEvent.click(screen.getByRole("button", { name: "Delete sample-sunset.jpg" }));
    expect(previews[0]!.deleteAsset).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(previews[0]!.deleteAsset).toHaveBeenCalledWith("sample-sunset.jpg"));
    // Reloaded after the change.
    await waitFor(() => expect(previews[0]!.listAssets).toHaveBeenCalledTimes(2));

    // A scene writing a file while the dialog is open reloads it too.
    act(() => previews[0]!.options.onAssetsChanged!());
    await waitFor(() => expect(previews[0]!.listAssets).toHaveBeenCalledTimes(3));

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Browser assets" })).toBeNull();
  });

  it("uploads picked files into the current folder", async () => {
    render(<SceneLivePreviewPanel sceneId="scene-1" scenes={[clockScene]} />);
    await waitFor(() => expect(previews).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: /Browser assets/ }));
    const input = screen.getByLabelText("Add files") as HTMLInputElement;
    const file = new File(["jpeg"], "holiday.jpg", { type: "image/jpeg" });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(previews[0]!.writeAsset).toHaveBeenCalledWith("holiday.jpg", file));
  });
});

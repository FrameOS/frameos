// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SceneLivePreview } from "./SceneLivePreview";

// The wasm runtime is a worker + emscripten bundle — not something jsdom can
// run. Capture the mount options instead and drive onFrame by hand.
const mountMock = vi.fn();
vi.mock("frameos-wasm", () => ({
  mountFrameOSManager: (container: HTMLElement, options: unknown) =>
    mountMock(container, options),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.includes("/scenes.json")) {
    return Response.json([{ id: "scene-runtime-1" }]);
  }
  if (url.includes("/api/settings")) {
    return Response.json({});
  }
  throw new Error(`Unexpected fetch: ${url}`);
});

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  mountMock.mockReturnValue({ destroy: vi.fn(), preview: {} });
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  cleanup();
  mountMock.mockReset();
  fetchMock.mockClear();
  vi.unstubAllGlobals();
});

describe("SceneLivePreview screenshot gating", () => {
  it("keeps the screenshot buttons disabled until the runtime paints a frame", async () => {
    render(<SceneLivePreview sceneId="scene-1" />);

    fireEvent.click(screen.getByText(/Live preview/));
    await waitFor(() => expect(mountMock).toHaveBeenCalledOnce());

    const saveButton = screen.getByRole("button", {
      name: /Download PNG/,
    }) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(true);
    expect(saveButton.title).toContain("first frame");

    const options = mountMock.mock.calls[0]![1] as {
      onFrame?: (frame: { width: number; height: number; renderMs: number }) => void;
    };
    expect(options.onFrame).toBeTypeOf("function");
    act(() => options.onFrame!({ height: 480, renderMs: 4, width: 800 }));

    expect(saveButton.disabled).toBe(false);
  });

  it("re-disables the button when the runtime is restarted", async () => {
    render(<SceneLivePreview sceneId="scene-1" />);

    fireEvent.click(screen.getByText(/Live preview/));
    await waitFor(() => expect(mountMock).toHaveBeenCalledOnce());
    const firstMount = mountMock.mock.calls[0]![1] as {
      onFrame?: (frame: { width: number; height: number; renderMs: number }) => void;
    };
    act(() => firstMount.onFrame!({ height: 480, renderMs: 4, width: 800 }));

    const saveButton = screen.getByRole("button", {
      name: /Download PNG/,
    }) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: /Restart/ }));
    await waitFor(() => expect(mountMock).toHaveBeenCalledTimes(2));
    expect(saveButton.disabled).toBe(true);
  });
});

describe("SceneLivePreview screenshot buttons", () => {
  it("offers Save to images only to the owner, Download to everyone", async () => {
    const { unmount } = render(<SceneLivePreview sceneId="scene-1" />);
    fireEvent.click(screen.getByText(/Live preview/));
    await waitFor(() => expect(mountMock).toHaveBeenCalledOnce());
    expect(screen.queryByRole("button", { name: /Save to images/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Download PNG/ })).toBeTruthy();
    unmount();

    render(<SceneLivePreview canSaveToGallery sceneId="scene-1" />);
    fireEvent.click(screen.getByText(/Live preview/));
    await waitFor(() => expect(mountMock).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("button", { name: /Save to images/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Download PNG/ })).toBeTruthy();
  });
});

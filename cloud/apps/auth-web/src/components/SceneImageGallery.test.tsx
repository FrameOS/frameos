// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SceneImageGallery } from "./SceneImageGallery";

const fetchMock = vi.fn<typeof fetch>();
const refreshMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: refreshMock }),
}));

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(window, "confirm").mockReturnValue(true);
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  cleanup();
  fetchMock.mockReset();
  refreshMock.mockReset();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("SceneImageGallery", () => {
  it("lets the owner remove the primary preview", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ status: "removed" }));
    render(
      <SceneImageGallery
        canEdit
        hasPreview
        imageIds={[]}
        sceneId="scene-1"
        sceneName="Bird field journal"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/account/scenes/scene-1/image",
        { method: "DELETE" },
      );
    });
    expect(refreshMock).toHaveBeenCalledOnce();
  });

  it("does not show removal controls to visitors", () => {
    render(
      <SceneImageGallery
        canEdit={false}
        hasPreview
        imageIds={[]}
        sceneId="scene-1"
        sceneName="Bird field journal"
      />,
    );

    expect(screen.queryByRole("button", { name: "Remove" })).toBe(null);
  });

  it("opens the editor with its live preview when the image is clicked", () => {
    const hashChanged = vi.fn();
    window.addEventListener("hashchange", hashChanged);
    render(
      <SceneImageGallery
        canEdit={false}
        canOpenLivePreview
        hasPreview
        imageIds={[]}
        sceneId="scene-1"
        sceneName="Bird field journal"
      />,
    );

    const link = screen.getByRole("link", {
      name: "Bird field journal preview",
    }) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("#scene-editor-preview");
    expect(link.textContent).toContain("Live preview");

    fireEvent.click(link);

    // Same URL + history-state convention as the "Live preview" button (the
    // scene editor with its Preview panel), and the hashchange nudge
    // SceneEditorModal's sync listens for.
    expect(window.location.hash).toBe("#scene-editor-preview");
    expect(window.history.state).toEqual({ frameosSceneEditor: true });
    expect(hashChanged).toHaveBeenCalledOnce();
    window.removeEventListener("hashchange", hashChanged);
  });

  it("keeps the image a plain image when the scene cannot be previewed", () => {
    render(
      <SceneImageGallery
        canEdit={false}
        canOpenLivePreview={false}
        hasPreview
        imageIds={[]}
        sceneId="scene-1"
        sceneName="Bird field journal"
      />,
    );

    expect(screen.queryByRole("link")).toBe(null);
    expect(screen.getByRole("img", { name: "Bird field journal preview" })).toBeTruthy();
    expect(window.location.hash).toBe("");
  });
});

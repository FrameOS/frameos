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

  it("shows thumbnails only in compact mode, each opening the lightbox", () => {
    render(
      <SceneImageGallery
        canEdit={false}
        compact
        hasPreview
        imageIds={["img-1", "img-2"]}
        sceneId="scene-1"
        sceneName="Bird field journal"
      />,
    );
    expect(screen.queryByRole("button", { name: "Bird field journal preview" })).toBeNull();
    expect(document.querySelector(".scene-gallery--compact")).toBeTruthy();
    const thumbs = screen.getAllByRole("button", { name: /View image \d full size/ });
    expect(thumbs.map((thumb) => thumb.querySelector("img")?.getAttribute("src"))).toEqual([
      "/api/store/scenes/scene-1/image",
      "/api/store/scenes/scene-1/images/img-1",
      "/api/store/scenes/scene-1/images/img-2",
    ]);
    // No "active" thumbnail: nothing is selected, each is its own trigger.
    expect(document.querySelector(".scene-gallery__thumb--active")).toBeNull();

    fireEvent.click(thumbs[2]!);
    const dialog = screen.getByRole("dialog", { name: "Scene image" });
    expect(dialog.querySelector("img")?.getAttribute("src")).toBe("/api/store/scenes/scene-1/images/img-2");
  });

  it("shows a single image's thumbnail in compact mode (there is no main image to stand in)", () => {
    render(
      <SceneImageGallery
        canEdit={false}
        compact
        hasPreview
        imageIds={[]}
        sceneId="scene-1"
        sceneName="Bird field journal"
      />,
    );
    expect(screen.getAllByRole("button", { name: /View image \d full size/ })).toHaveLength(1);
  });

  it("blows the main image up in the lightbox when it is clicked", () => {
    render(
      <SceneImageGallery
        canEdit={false}
        hasPreview
        imageIds={[]}
        sceneId="scene-1"
        sceneName="Bird field journal"
      />,
    );
    expect(screen.queryByRole("dialog")).toBe(null);
    fireEvent.click(screen.getByRole("button", { name: "Bird field journal preview" }));

    const dialog = screen.getByRole("dialog", { name: "Scene image" });
    const image = dialog.querySelector("img")!;
    expect(image.getAttribute("src")).toBe("/api/store/scenes/scene-1/image");
    expect(image.className).toContain("lightbox__image--fit");
    fireEvent.click(image);
    expect(image.className).not.toContain("lightbox__image--fit");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBe(null);
    // Nothing touched the URL.
    expect(window.location.hash).toBe("");
  });
});

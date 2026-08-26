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

function thumbs() {
  return screen.getAllByRole("button", { name: /View image \d full size/ });
}

describe("SceneImageGallery", () => {
  it("shows every image as an equal thumbnail, the zip's preview first", () => {
    render(
      <SceneImageGallery
        canEdit={false}
        hasPreview
        imageIds={["img-1", "img-2"]}
        sceneId="scene-1"
        sceneName="Bird field journal"
        share="tok"
      />,
    );
    expect(thumbs().map((thumb) => thumb.querySelector("img")?.getAttribute("src"))).toEqual([
      "/api/store/scenes/scene-1/image?share=tok",
      "/api/store/scenes/scene-1/images/img-1?share=tok",
      "/api/store/scenes/scene-1/images/img-2?share=tok",
    ]);
    // No large image, nothing "selected": each thumbnail is its own trigger.
    expect(document.querySelectorAll(".scene-gallery img")).toHaveLength(3);
    expect(screen.queryByRole("button", { name: "Bird field journal preview" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Remove/ })).toBeNull();
  });

  it("lets the owner remove the primary preview and an uploaded image from the grid", async () => {
    fetchMock.mockResolvedValue(Response.json({ status: "removed" }));
    render(
      <SceneImageGallery
        canEdit
        hasPreview
        imageIds={["img-1"]}
        sceneId="scene-1"
        sceneName="Bird field journal"
      />,
    );
    expect(screen.getByRole("button", { name: "Add an image to this scene's page" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Remove image 1" }));
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/account/scenes/scene-1/image", { method: "DELETE" });
      expect(refreshMock).toHaveBeenCalledTimes(1);
    });
    fireEvent.click(screen.getByRole("button", { name: "Remove image 2" }));
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/account/scenes/scene-1/images/img-1", {
        method: "DELETE",
      });
    });
    expect(refreshMock).toHaveBeenCalledTimes(2);
  });

  it("lets the owner drag a gallery image into a new slot and saves the order", async () => {
    fetchMock.mockResolvedValue(Response.json({ status: "reordered" }));
    render(
      <SceneImageGallery
        canEdit
        hasPreview
        imageIds={["img-1", "img-2", "img-3"]}
        sceneId="scene-1"
        sceneName="Bird field journal"
      />,
    );
    const wrapOf = (id: string) => document.querySelector(`[data-image-id="${id}"]`) as HTMLElement;
    // The zip's own preview leads and is not draggable; gallery images are.
    expect(thumbs()[0]!.parentElement!.getAttribute("draggable")).toBeNull();
    expect(wrapOf("img-1").getAttribute("draggable")).toBe("true");

    const dataTransfer = { effectAllowed: "", setData: vi.fn() };
    fireEvent.dragStart(wrapOf("img-1"), { dataTransfer });
    fireEvent.dragOver(wrapOf("img-3"), { dataTransfer });
    expect(wrapOf("img-3").className).toContain("scene-gallery__thumb-wrap--drop-target");
    fireEvent.drop(wrapOf("img-3"), { dataTransfer });

    // Optimistic: the grid already shows the new order.
    expect(thumbs().map((thumb) => thumb.querySelector("img")?.getAttribute("src"))).toEqual([
      "/api/store/scenes/scene-1/image",
      "/api/store/scenes/scene-1/images/img-2",
      "/api/store/scenes/scene-1/images/img-3",
      "/api/store/scenes/scene-1/images/img-1",
    ]);
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/account/scenes/scene-1/images", {
        body: JSON.stringify({ order: ["img-2", "img-3", "img-1"] }),
        headers: { "content-type": "application/json" },
        method: "PATCH",
      });
      expect(refreshMock).toHaveBeenCalledTimes(1);
    });
  });

  it("falls back to the server order when a reorder is rejected", async () => {
    fetchMock.mockResolvedValue(Response.json({ error: "invalid_order" }, { status: 400 }));
    render(
      <SceneImageGallery
        canEdit
        hasPreview={false}
        imageIds={["img-1", "img-2"]}
        sceneId="scene-1"
        sceneName="Bird field journal"
      />,
    );
    const wrapOf = (id: string) => document.querySelector(`[data-image-id="${id}"]`) as HTMLElement;
    const dataTransfer = { effectAllowed: "", setData: vi.fn() };
    fireEvent.dragStart(wrapOf("img-2"), { dataTransfer });
    fireEvent.dragOver(wrapOf("img-1"), { dataTransfer });
    fireEvent.drop(wrapOf("img-1"), { dataTransfer });
    expect(thumbs().map((thumb) => thumb.querySelector("img")?.getAttribute("src"))).toEqual([
      "/api/store/scenes/scene-1/images/img-2",
      "/api/store/scenes/scene-1/images/img-1",
    ]);
    await vi.waitFor(() => {
      expect(screen.getByRole("alert").textContent).toBe("Reordering failed: invalid_order");
    });
    expect(thumbs().map((thumb) => thumb.querySelector("img")?.getAttribute("src"))).toEqual([
      "/api/store/scenes/scene-1/images/img-1",
      "/api/store/scenes/scene-1/images/img-2",
    ]);
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("blows a thumbnail up in the lightbox when it is clicked", () => {
    render(
      <SceneImageGallery
        canEdit={false}
        hasPreview
        imageIds={["img-1"]}
        sceneId="scene-1"
        sceneName="Bird field journal"
      />,
    );
    expect(screen.queryByRole("dialog")).toBe(null);
    fireEvent.click(thumbs()[1]!);

    const dialog = screen.getByRole("dialog", { name: "Scene image" });
    const image = dialog.querySelector("img")!;
    expect(image.getAttribute("src")).toBe("/api/store/scenes/scene-1/images/img-1");
    expect(image.className).toContain("lightbox__image--fit");
    fireEvent.click(image);
    expect(image.className).not.toContain("lightbox__image--fit");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBe(null);
    // Nothing touched the URL.
    expect(window.location.hash).toBe("");
  });

  it("shows a placeholder to visitors of a scene without images, and just the add button to its owner", () => {
    const { unmount } = render(
      <SceneImageGallery canEdit={false} hasPreview={false} imageIds={[]} sceneId="scene-1" sceneName="Empty" />,
    );
    expect(screen.getByText("No preview")).toBeTruthy();
    unmount();
    render(<SceneImageGallery canEdit hasPreview={false} imageIds={[]} sceneId="scene-1" sceneName="Empty" />);
    expect(screen.queryByText("No preview")).toBeNull();
    expect(screen.getByRole("button", { name: "Add an image to this scene's page" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /View image/ })).toBeNull();
  });
});

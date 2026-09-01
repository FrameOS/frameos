// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SceneImageGallery } from "./SceneImageGallery";

const fetchMock = vi.fn<typeof fetch>();

const shaA = "a".repeat(64);
const shaB = "b".repeat(64);
const shaC = "c".repeat(64);

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  cleanup();
  fetchMock.mockReset();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function thumbs() {
  return screen.getAllByRole("button", { name: /View image \d full size/ });
}

function srcs() {
  return thumbs().map((thumb) => thumb.querySelector("img")?.getAttribute("src"));
}

describe("SceneImageGallery", () => {
  it("shows the version's images as equal thumbnails, the cover first", () => {
    render(
      <SceneImageGallery
        canEdit={false}
        images={[shaA, shaB]}
        sceneId="scene-1"
        sceneName="Bird field journal"
        share="tok"
      />,
    );
    expect(srcs()).toEqual([
      `/api/store/scenes/scene-1/images/${shaA}?share=tok`,
      `/api/store/scenes/scene-1/images/${shaB}?share=tok`,
    ]);
    // No large image, nothing "selected": each thumbnail is its own trigger.
    expect(document.querySelectorAll(".scene-gallery img")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: /Remove/ })).toBeNull();
  });

  it("hands the owner's removals to the draft instead of the server", () => {
    const onChange = vi.fn();
    render(
      <SceneImageGallery
        canEdit
        images={[shaA, shaB]}
        onChange={onChange}
        sceneId="scene-1"
        sceneName="Bird field journal"
      />,
    );
    expect(screen.getByRole("button", { name: /Add an image to this scene/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove image 1" }));
    expect(onChange).toHaveBeenCalledWith([shaB]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("lets the owner drag an image into a new slot — the draft's order, nothing saved", () => {
    const onChange = vi.fn();
    render(
      <SceneImageGallery
        canEdit
        images={[shaA, shaB, shaC]}
        onChange={onChange}
        sceneId="scene-1"
        sceneName="Bird field journal"
      />,
    );
    const wrapOf = (sha: string) => document.querySelector(`[data-image-id="${sha}"]`) as HTMLElement;
    // Every image is draggable, the cover included: position 0 IS the cover.
    expect(wrapOf(shaA).getAttribute("draggable")).toBe("true");

    const dataTransfer = { effectAllowed: "", setData: vi.fn() };
    fireEvent.dragStart(wrapOf(shaA), { dataTransfer });
    fireEvent.dragOver(wrapOf(shaC), { dataTransfer });
    expect(wrapOf(shaC).className).toContain("scene-gallery__thumb-wrap--drop-target");
    fireEvent.drop(wrapOf(shaC), { dataTransfer });

    expect(onChange).toHaveBeenCalledWith([shaB, shaC, shaA]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("registers an upload with the server and appends its digest to the draft", async () => {
    fetchMock.mockResolvedValue(Response.json({ image: { sha256: shaC }, status: "registered" }));
    const onChange = vi.fn();
    render(
      <SceneImageGallery
        canEdit
        images={[shaA]}
        onChange={onChange}
        sceneId="scene-1"
        sceneName="Bird field journal"
      />,
    );
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" });
    fireEvent.change(input, { target: { files: [file] } });
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith([shaA, shaC]));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/account/scenes/scene-1/images",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("explains a refused upload and leaves the draft alone", async () => {
    fetchMock.mockResolvedValue(Response.json({ error: "content_rejected" }, { status: 422 }));
    const onChange = vi.fn();
    render(
      <SceneImageGallery
        canEdit
        images={[shaA]}
        onChange={onChange}
        sceneId="scene-1"
        sceneName="Bird field journal"
      />,
    );
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File([new Uint8Array([1])], "x.png", { type: "image/png" })] },
    });
    await vi.waitFor(() => {
      expect(screen.getByRole("alert").textContent).toBe("Rejected by content moderation");
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("blows a thumbnail up in the lightbox when it is clicked", () => {
    render(
      <SceneImageGallery
        canEdit={false}
        images={[shaA, shaB]}
        sceneId="scene-1"
        sceneName="Bird field journal"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "View image 2 full size" }));
    const dialog = screen.getByRole("dialog", { name: "Scene image" });
    expect(dialog.querySelector("img")?.getAttribute("src")).toBe(
      `/api/store/scenes/scene-1/images/${shaB}`,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows a placeholder for a scene without images, and no add button for visitors", () => {
    render(<SceneImageGallery canEdit={false} images={[]} sceneId="scene-1" sceneName="Empty" />);
    expect(screen.getByText("No preview")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Add an image/ })).toBeNull();
  });
});

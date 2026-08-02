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
});

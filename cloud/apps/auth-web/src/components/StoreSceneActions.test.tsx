// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StoreSceneActions } from "./StoreSceneActions";

const { captureMock, fetchMock, refreshMock, replaceMock } = vi.hoisted(() => ({
  captureMock: vi.fn(),
  fetchMock: vi.fn<typeof fetch>(),
  refreshMock: vi.fn(),
  replaceMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/s/private-scene",
  useRouter: () => ({ refresh: refreshMock, replace: replaceMock }),
}));

vi.mock("posthog-js", () => ({
  default: { capture: captureMock },
}));

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  captureMock.mockReset();
  fetchMock.mockReset();
  refreshMock.mockReset();
  replaceMock.mockReset();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("StoreSceneActions", () => {
  it("redirects a deleted detail page to My scenes", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ status: "deleted" }));
    render(
      <StoreSceneActions
        name="Private scene"
        sceneId="scene-1"
        status="active"
        visibility="private"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await vi.waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith("/account/scenes");
    });
    expect(refreshMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/account/scenes/scene-1",
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(captureMock).toHaveBeenCalledWith("scene_deleted", {
      scene_id: "scene-1",
    });
  });
});

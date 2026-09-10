// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StoreSceneActions, StoreSceneMenu } from "./StoreSceneActions";

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

function deleteDialog(name: string) {
  return screen.getByRole("dialog", { name: `Delete ${name}` });
}

// The delete dialog's own confirm: type the scene's name, submit.
function confirmDelete(name: string) {
  const box = deleteDialog(name);
  fireEvent.change(within(box).getByLabelText(/to confirm/), {
    target: { value: name },
  });
  fireEvent.click(within(box).getByRole("button", { name: "Delete scene" }));
}

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
    confirmDelete("Private scene");

    await vi.waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith("/my-scenes");
    });
    expect(window.confirm).not.toHaveBeenCalled();
    expect(refreshMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/account/scenes/scene-1",
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(captureMock).toHaveBeenCalledWith("scene_deleted", {
      scene_id: "scene-1",
    });
  });

  it("deletes only after the scene's name is typed, and never on a browser confirm", async () => {
    render(
      <StoreSceneActions
        name="Sunrise Clock"
        sceneId="scene-1"
        status="active"
        visibility="public"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const box = deleteDialog("Sunrise Clock");
    const submit = within(box).getByRole("button", { name: "Delete scene" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(within(box).getByText(/yank that version instead/)).toBeTruthy();

    fireEvent.change(within(box).getByLabelText(/to confirm/), {
      target: { value: "Sunrise" },
    });
    expect(submit.disabled).toBe(true);
    fireEvent.click(submit);
    expect(fetchMock).not.toHaveBeenCalled();

    // Backing out closes the dialog without a request.
    fireEvent.click(within(box).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(window.confirm).not.toHaveBeenCalled();
  });

  it("keeps the delete dialog open with the error when the server refuses", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ error: "scene_pulled" }, { status: 409 }),
    );
    render(
      <StoreSceneMenu
        name="Private scene"
        sceneId="scene-1"
        status="active"
        visibility="private"
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "More actions for Private scene" }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    // The menu handed off to the dialog.
    await vi.waitFor(() => {
      expect(screen.queryByRole("menu")).toBeNull();
    });
    confirmDelete("Private scene");

    await vi.waitFor(() => {
      expect(within(deleteDialog("Private scene")).getByText(/pulled/i)).toBeTruthy();
    });
    expect(replaceMock).not.toHaveBeenCalled();
    expect(captureMock).not.toHaveBeenCalled();
  });

  it("keeps the menu open with the error when an action is refused", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json(
        { categories: ["violence"], error: "content_rejected" },
        { status: 422 },
      ),
    );
    render(
      <StoreSceneMenu
        name="Private scene"
        sceneId="scene-1"
        status="active"
        visibility="private"
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "More actions for Private scene" }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Make public" }));

    await vi.waitFor(() => {
      expect(
        screen.getByText("Rejected by content moderation (violence)"),
      ).toBeTruthy();
    });
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(refreshMock).not.toHaveBeenCalled();
    expect(captureMock).not.toHaveBeenCalled();
  });
});

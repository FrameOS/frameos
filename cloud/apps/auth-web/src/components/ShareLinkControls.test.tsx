// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ShareLinkControls } from "./ShareLinkControls";

const { fetchMock, refreshMock } = vi.hoisted(() => ({
  fetchMock: vi.fn<typeof fetch>(),
  refreshMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: refreshMock }),
}));

const shareUrl = "https://scenes.frameos.net/s/private-scene?share=tok-1";

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

describe("ShareLinkControls", () => {
  it("shows the link and copies it", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.assign(navigator, { clipboard: { writeText } });
    render(<ShareLinkControls sceneId="scene-1" shareUrl={shareUrl} />);

    expect(screen.getByTestId("share-link-url").textContent).toBe(shareUrl);
    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    await screen.findByRole("button", { name: "Copied" });
    expect(writeText).toHaveBeenCalledWith(shareUrl);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("replaces the link through the account route, after a confirm, and refreshes the page", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ status: "updated" }));
    render(<ShareLinkControls sceneId="scene-1" shareUrl={shareUrl} />);

    fireEvent.click(screen.getByRole("button", { name: "Replace link" }));
    await vi.waitFor(() => expect(refreshMock).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/account/scenes/scene-1",
      expect.objectContaining({ body: JSON.stringify({ share: "rotate" }), method: "PATCH" }),
    );
  });

  it("does nothing when the owner backs out of the confirm", () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<ShareLinkControls sceneId="scene-1" shareUrl={shareUrl} />);
    fireEvent.click(screen.getByRole("button", { name: "Turn sharing off" }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("turns sharing off and back on", async () => {
    fetchMock.mockResolvedValue(Response.json({ status: "updated" }));
    const { unmount } = render(<ShareLinkControls sceneId="scene-1" shareUrl={shareUrl} />);
    fireEvent.click(screen.getByRole("button", { name: "Turn sharing off" }));
    await vi.waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toEqual({ share: "disable" });
    unmount();

    // Sharing off: no link, no copy — only the way back on (no confirm:
    // nothing is lost by minting a link).
    vi.spyOn(window, "confirm").mockImplementation(() => {
      throw new Error("no confirm expected");
    });
    render(<ShareLinkControls sceneId="scene-1" shareUrl={null} />);
    expect(screen.queryByTestId("share-link-url")).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy link" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Turn sharing on" }));
    await vi.waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(2));
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1]!.body))).toEqual({ share: "rotate" });
  });

  it("shows the server's reason instead of a bare Failed", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ error: "scene_pulled" }, { status: 403 }));
    render(<ShareLinkControls sceneId="scene-1" shareUrl={shareUrl} />);
    fireEvent.click(screen.getByRole("button", { name: "Replace link" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/pulled by moderation/);
    expect(refreshMock).not.toHaveBeenCalled();

    fetchMock.mockResolvedValueOnce(Response.json({ error: "rate_limited" }, { status: 429 }));
    fireEvent.click(screen.getByRole("button", { name: "Replace link" }));
    await vi.waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/Too many changes/));

    fetchMock.mockResolvedValueOnce(new Response("boom", { status: 500 }));
    fireEvent.click(screen.getByRole("button", { name: "Replace link" }));
    await vi.waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Failed (500)"));
  });
});

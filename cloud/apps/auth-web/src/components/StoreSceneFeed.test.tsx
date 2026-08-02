// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StoreSceneFeed } from "./StoreSceneFeed";
import type { StoreBrowseScene } from "../lib/store-browse";
import type { StoreBrowseFilters } from "../lib/store-filters";

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  // jsdom has no IntersectionObserver; the button path is what we drive here.
  vi.stubGlobal("IntersectionObserver", undefined);
});

afterEach(() => {
  cleanup();
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

const noFilters: StoreBrowseFilters = {
  category: "",
  query: "",
  tag: "",
  version: "",
};

function scene(name: string): StoreBrowseScene {
  return {
    category: null,
    description: null,
    downloadCount: 0,
    frameosVersion: null,
    hasPreview: false,
    id: name,
    name,
    publisher: "Someone",
    riskFlags: [],
    slug: name,
    tags: [],
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
}

describe("StoreSceneFeed", () => {
  it("appends the next page and keeps the active filters", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ hasMore: false, page: 2, scenes: [scene("Second")] }),
    );
    render(
      <StoreSceneFeed
        filters={{ ...noFilters, version: "2026.9.0" }}
        initialScenes={[scene("First")]}
        loadedPage={1}
        totalPages={2}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Load more scenes" }));

    await waitFor(() => expect(screen.getByText("Second")).toBeTruthy());
    expect(screen.getByText("First")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/store/browse?version=2026.9.0&page=2",
    );
    // Nothing left to load: the control disappears.
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("offers a retry when a page fails to load", async () => {
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 500 }));
    render(
      <StoreSceneFeed
        filters={noFilters}
        initialScenes={[scene("First")]}
        loadedPage={1}
        totalPages={3}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Load more scenes" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy(),
    );

    fetchMock.mockResolvedValueOnce(
      Response.json({ hasMore: true, page: 2, scenes: [scene("Second")] }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByText("Second")).toBeTruthy());
  });

  it("stops asking for more once a page comes back short", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ hasMore: false, page: 2, scenes: [] }),
    );
    render(
      <StoreSceneFeed
        filters={noFilters}
        heading="More from the store"
        initialScenes={[]}
        loadedPage={1}
        totalPages={5}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Load more scenes" }));
    await waitFor(() => expect(screen.queryByRole("button")).toBeNull());
    // The heading only appears once there is something under it.
    expect(screen.queryByText("More from the store")).toBeNull();
  });
});

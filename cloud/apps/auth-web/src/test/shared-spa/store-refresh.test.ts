// @vitest-environment jsdom
//
// A scene made public must show on the store page at once. The cloud's
// public index allows five minutes of caching (installs poll it), so the SPA
// asks past the browser cache; a backend keeps its copy of the store for a
// day, so the store page's Refresh makes it fetch the provider's index now.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiFetchMock = vi.hoisted(() => vi.fn<(input: string, init?: RequestInit) => Promise<Response>>());
vi.mock("../../../../../../frontend/src/utils/apiFetch", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    apiFetch: (input: string, init?: RequestInit) => apiFetchMock(input, init),
  };
});

import { initKea } from "../../../../../../frontend/src/initKea";
import { repositoriesModel } from "../../../../../../frontend/src/models/repositoriesModel";
import { scenesLibraryLogic } from "../../../../../../frontend/src/scenes/store/scenesLibraryLogic";
import { trackedStoreRepositoryIds } from "../../../../../../frontend/src/scenes/store/storeCatalog";
import type { RepositoryType } from "../../../../../../frontend/src/types";

type CloudTestWindow = Window & {
  FRAMEOS_APP_CONFIG?: Record<string, unknown>;
  FRAMEOS_EMBEDDED_NO_BACKEND?: boolean;
};
const testWindow = window as CloudTestWindow;

const storeRow: RepositoryType = {
  id: "7",
  name: "FrameOS Cloud store",
  url: "https://cloud.frameos.net/api/store/2026.10.16/repository.json",
  last_updated_at: new Date().toISOString(),
  templates: [{ id: "weather", name: "Weather", category: "weather" }],
} as RepositoryType;
const otherRow: RepositoryType = {
  id: "8",
  name: "Samples",
  url: "https://repo.example/samples/repository.json",
  last_updated_at: new Date().toISOString(),
  templates: [],
} as RepositoryType;

function calls(): Array<[string, string]> {
  return apiFetchMock.mock.calls.map(([url, init]) => [init?.method ?? "GET", url]);
}

beforeEach(() => {
  // No websocket: socketLogic opens none with the flag on.
  testWindow.FRAMEOS_EMBEDDED_NO_BACKEND = true;
  apiFetchMock.mockReset();
});

afterEach(() => {
  delete testWindow.FRAMEOS_APP_CONFIG;
  delete testWindow.FRAMEOS_EMBEDDED_NO_BACKEND;
});

describe("trackedStoreRepositoryIds", () => {
  it("is the store rows a backend tracks, not other repositories or a system row", () => {
    expect(
      trackedStoreRepositoryIds([
        storeRow,
        otherRow,
        { id: "system-cloud-store", name: "Store", url: "/api/store/repository.json" } as RepositoryType,
      ]),
    ).toEqual(["7"]);
  });
});

describe("the store catalog on the cloud", () => {
  it("is fetched past the browser cache", async () => {
    testWindow.FRAMEOS_APP_CONFIG = { cloudMode: true };
    apiFetchMock.mockImplementation(async () => Response.json({ name: "Store", templates: [] }));
    initKea({ memoryRouter: true });
    const unmount = repositoriesModel.mount();
    await vi.waitFor(() => expect(repositoriesModel.values.repositoriesLoading).toBe(false));
    expect(apiFetchMock).toHaveBeenCalledWith("/api/store/repository.json", { cache: "no-cache" });
    unmount();
  });
});

describe("the store page's Refresh on a backend", () => {
  it("asks the backend to fetch the store's index again", async () => {
    apiFetchMock.mockImplementation(async (url, init) => {
      if (url === "/api/repositories") {
        return Response.json([storeRow, otherRow]);
      }
      if (url === "/api/templates" || url === "/api/frames") {
        return Response.json(url === "/api/frames" ? { frames: [] } : []);
      }
      if (url === "/api/repositories/7" && init?.method === "PATCH") {
        return Response.json({
          ...storeRow,
          templates: [...(storeRow.templates ?? []), { id: "chess", name: "Chess puzzle", category: "fun" }],
        });
      }
      return new Response("null", { status: 404 });
    });
    initKea({ memoryRouter: true });
    const unmount = scenesLibraryLogic.mount();
    await vi.waitFor(() => expect(scenesLibraryLogic.values.repositories).toHaveLength(2));

    apiFetchMock.mockClear();
    scenesLibraryLogic.actions.refreshStore();
    await vi.waitFor(() =>
      expect(scenesLibraryLogic.values.storeTemplates.map((template) => template.id)).toEqual(["weather", "chess"]),
    );
    expect(calls().filter(([, url]) => url.startsWith("/api/repositories"))).toEqual([
      ["PATCH", "/api/repositories/7"],
    ]);
    unmount();
  });
});

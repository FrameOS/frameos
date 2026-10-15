// @vitest-environment jsdom
// The signed-out scene store (the cloud's /store, the scenes host's root):
// the shared SPA's PublicStoreFront, which must read the public store index
// and nothing account-scoped — a 401 there would send the visitor to /login.
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiFetchMock = vi.hoisted(() => vi.fn<(input: string) => Promise<Response>>());
vi.mock("../../../../../../frontend/src/utils/apiFetch", () => ({
  apiFetch: (input: string) => apiFetchMock(input),
  hasNoBackend: () => false,
  logApiError: () => undefined,
}));

import { initKea } from "../../../../../../frontend/src/initKea";
import { PublicStoreFront } from "../../../../../../frontend/src/scenes/store/PublicStoreFront";

type CloudTestWindow = Window & {
  FRAMEOS_APP_CONFIG?: Record<string, unknown>;
};
const testWindow = window as CloudTestWindow;

const repository = {
  name: "FrameOS Cloud store",
  description: "Scenes",
  templates: [
    {
      author: "Marius",
      category: "weather",
      description: "A big clock",
      id: "big-clock",
      name: "Big clock",
      sceneId: "11111111-1111-4111-8111-111111111111",
      tags: ["clock", "e-ink"],
      url: "https://scenes.example/s/big-clock",
      version: "3",
      zip: "./scenes/big-clock/download",
    },
    {
      author: "Marius",
      category: "photos",
      description: "A slideshow",
      id: "slideshow",
      name: "Slideshow",
      sceneId: "22222222-2222-4222-8222-222222222222",
      tags: ["photos"],
      url: "https://scenes.example/s/slideshow",
      version: "1",
      zip: "./scenes/slideshow/download",
    },
  ],
};

beforeEach(() => {
  testWindow.FRAMEOS_APP_CONFIG = {
    cloudMode: true,
    cloud_signed_in: false,
    cloud_login_url: "https://cloud.example/login",
    ingress_path: "",
    route_base_path: "/frames",
  };
  window.history.replaceState({}, "", "/store");
  document.body.innerHTML = '<div id="popper"></div><div id="root"></div>';
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation(async (url) => {
    if (url.startsWith("/api/store/repository.json")) {
      return Response.json(repository);
    }
    throw new Error(`unexpected request: ${url}`);
  });
  initKea({ memoryRouter: true });
});

afterEach(() => {
  cleanup();
  delete testWindow.FRAMEOS_APP_CONFIG;
});

describe("the signed-out store front", () => {
  it("renders the store from the public index alone, with a way to sign in", async () => {
    render(<PublicStoreFront />);

    expect(screen.getByRole("heading", { name: "Scene store" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe(
      "https://cloud.example/login",
    );
    await waitFor(() => expect(screen.getByText("Big clock")).toBeTruthy());
    expect(screen.getByText("Slideshow")).toBeTruthy();
    // The tile is the scene's own page.
    expect(screen.getByText("Big clock").closest("a")?.getAttribute("href")).toBe(
      "https://scenes.example/s/big-clock",
    );
    // Categories as a row of pills, tags at the bottom.
    const categories = screen.getByRole("navigation", { name: "Categories" });
    expect(within(categories).getByRole("link", { name: /Weather/ })).toBeTruthy();
    expect(within(categories).getByRole("link", { name: /All scenes/ })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /e-ink/ }).length).toBeGreaterThan(0);
    // Only the public index was asked for.
    for (const [url] of apiFetchMock.mock.calls) {
      expect(url.startsWith("/api/store/repository.json")).toBe(true);
    }
    // No workspace around it.
    expect(document.querySelector("aside.workspace-sidebar")).toBeNull();
  });
});

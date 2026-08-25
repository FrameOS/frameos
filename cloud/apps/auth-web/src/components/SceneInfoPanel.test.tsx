// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SceneInfoPanel, type SceneInfoData } from "./SceneInfoPanel";

const { fetchMock, refreshMock } = vi.hoisted(() => ({
  fetchMock: vi.fn<typeof fetch>(),
  refreshMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/s/clock",
  useRouter: () => ({ refresh: refreshMock, replace: vi.fn() }),
}));

vi.mock("posthog-js", () => ({
  default: { capture: vi.fn() },
}));

const info: SceneInfoData = {
  framesUrl: "https://cloud.frameos.net/frames/",
  imageIds: ["img-1"],
  installableFrames: null,
  isAdmin: false,
  isOwner: false,
  pageUrl: "https://scenes.frameos.net/s/clock",
  scene: {
    accountId: "acc-1",
    category: "weather",
    description: "A **station** clock.",
    downloadCount: 12,
    frameosVersion: "2026.8.1",
    hasPreview: true,
    id: "scene-1",
    latestVersion: 2,
    name: "Clock",
    publisher: "Marius",
    pulledReason: null,
    riskFlags: [],
    slug: "clock",
    status: "active",
    tags: ["clock", "e-ink"],
    updatedAt: "2026-08-24T10:00:00.000Z",
    visibility: "public",
  },
  signedIn: false,
  versions: [
    {
      createdAt: "2026-08-24T10:00:00.000Z",
      frameosVersion: "2026.8.1",
      sha256: "abcdef0123456789abcdef0123456789",
      sizeBytes: 2048,
      version: 2,
      yankedAt: null,
    },
    {
      createdAt: "2026-08-10T10:00:00.000Z",
      frameosVersion: null,
      sha256: "0123456789abcdef0123456789abcdef",
      sizeBytes: 1024,
      version: 1,
      yankedAt: null,
    },
  ],
};

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  window.history.replaceState(null, "", "/s/clock");
});

afterEach(() => {
  cleanup();
  fetchMock.mockReset();
  refreshMock.mockReset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("SceneInfoPanel", () => {
  it("shows the publisher line, gallery, description and versions from its props", () => {
    render(<SceneInfoPanel {...info} />);

    expect(screen.getByText(/12 downloads/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Marius" }).getAttribute("href")).toBe("/publishers/acc-1");
    expect(screen.getByText(/requires FrameOS 2026.8.1 or newer/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Report scene" })).toBeTruthy();

    // Gallery: the zip's preview plus the uploaded image, thumbnails only
    // (decorative, alt=""), each a lightbox trigger; no removal for visitors.
    expect(screen.getAllByRole("button", { name: /View image \d full size/ })).toHaveLength(2);
    expect(document.querySelectorAll(".scene-gallery img")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: /Remove image/ })).toBeNull();

    // Category and tags link into the store.
    expect(screen.getByRole("link", { name: "Weather" }).getAttribute("href")).toBe("/?category=weather");
    expect(screen.getByRole("link", { name: "e-ink" }).getAttribute("href")).toBe("/?tag=e-ink");

    // Description as markdown; no owner editors.
    expect(screen.getByText("station").tagName).toBe("STRONG");
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();

    // Installing lives in the bar's dialog, not here.
    expect(screen.queryByRole("textbox", { name: "URL to copy" })).toBeNull();
    expect(screen.queryByRole("heading", { name: /Install/ })).toBeNull();

    // The versions live in the bar (its dropdown and "Manage versions…"
    // dialog), not in the column.
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Versions" })).toBeNull();
    expect(screen.queryByRole("link", { name: "v2" })).toBeNull();
  });

  it("keeps the share token on every link of a private scene, and explains it", () => {
    render(
      <SceneInfoPanel
        {...info}
        scene={{ ...info.scene, visibility: "private" }}
        share="tok"
      />,
    );
    expect(
      screen.getByRole("button", { name: "View image 1 full size" }).querySelector("img")?.getAttribute("src"),
    ).toBe("/api/store/scenes/scene-1/image?share=tok");
    expect(screen.getByText(/viewing it through a sharing link/)).toBeTruthy();
    // A private scene cannot be reported.
    expect(screen.queryByRole("button", { name: "Report scene" })).toBeNull();
  });

  it("gives the owner the editors, the image controls and the visibility actions", () => {
    render(
      <SceneInfoPanel
        {...info}
        installableFrames={[{ connected: true, id: "f1", name: "Kitchen", status: "active" }]}
        isOwner
        scene={{ ...info.scene, visibility: "private" }}
        signedIn
      />,
    );
    expect(screen.getAllByRole("button", { name: /Remove image \d/ })).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Add an image to this scene's page" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit tags" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit category" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Edit minimum FrameOS version/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Make public" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();
    // No per-version actions here: those are in the bar's versions dialog.
    expect(screen.queryByRole("button", { name: "Unpublish" })).toBeNull();
    expect(screen.getByText(/only visible to you/)).toBeTruthy();
  });


  it("heads the column with the name it is given as a heading, the publisher line under it, then the images", () => {
    render(<SceneInfoPanel {...info} heading={<span>Clock title</span>} />);
    const heading = screen.getByRole("heading", { level: 1, name: "Clock title" });
    const byline = screen.getByText(/12 downloads/);
    const gallery = document.querySelector(".scene-gallery")!;
    const header = document.querySelector(".scene-info")!.firstElementChild!;
    expect(header.contains(heading)).toBe(true);
    expect(header.contains(byline)).toBe(true);
    expect(heading.compareDocumentPosition(byline) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(byline.compareDocumentPosition(gallery) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Thumbnails open the lightbox.
    fireEvent.click(screen.getByRole("button", { name: "View image 2 full size" }));
    expect(
      screen.getByRole("dialog", { name: "Scene image" }).querySelector("img")?.getAttribute("src"),
    ).toBe("/api/store/scenes/scene-1/images/img-1");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("has no heading element when it is given none", () => {
    render(<SceneInfoPanel {...info} />);
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
  });
});

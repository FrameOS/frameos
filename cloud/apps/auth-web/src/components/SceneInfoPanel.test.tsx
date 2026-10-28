// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import versions from "../../../../../versions.json";
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

const shaA = "a".repeat(64);
const shaB = "b".repeat(64);

const info: SceneInfoData = {
  framesUrl: "https://cloud.frameos.net/frames/",
  images: [shaA, shaB],
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
      images: [shaA, shaB],
      listing: {
        category: "weather",
        description: "A **station** clock.",
        frameosVersion: "2026.8.1",
        tags: ["clock", "e-ink"],
      },
      message: null,
      sha256: "abcdef0123456789abcdef0123456789",
      sizeBytes: 2048,
      version: 2,
      yankedAt: null,
    },
    {
      createdAt: "2026-08-10T10:00:00.000Z",
      frameosVersion: null,
      images: [shaB],
      listing: { category: null, description: "An old clock.", frameosVersion: null, tags: [] },
      message: null,
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
    // The facts: the category into the store, the FrameOS it needs; the
    // visibility is the owner's.
    expect(screen.getByText("2026.8.1 or newer").closest("dd")?.previousElementSibling?.textContent).toBe("FrameOS");
    expect(screen.queryByText("Visibility")).toBeNull();
    expect(screen.getByRole("button", { name: "Report scene" })).toBeTruthy();

    // Gallery: the zip's preview plus the uploaded image, thumbnails only
    // (decorative, alt=""), each a lightbox trigger; no removal for visitors.
    expect(screen.getAllByRole("button", { name: /View image \d full size/ })).toHaveLength(2);
    expect(document.querySelectorAll(".scene-gallery img")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: /Remove image/ })).toBeNull();

    // The category links into the store; tags are not shown any more.
    expect(screen.getByRole("link", { name: "Weather" }).getAttribute("href")).toBe("/?category=weather");
    expect(screen.queryByText("e-ink")).toBeNull();

    // Description as markdown; no owner editors.
    expect(screen.getByText("station").tagName).toBe("STRONG");
    expect(screen.queryByRole("button", { name: "Edit description" })).toBeNull();

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
    ).toBe(`/api/store/scenes/scene-1/images/${shaA}?share=tok`);
    expect(screen.getByText(/viewing it through a sharing link/)).toBeTruthy();
    // A private scene cannot be reported.
    expect(screen.queryByRole("button", { name: "Report scene" })).toBeNull();
    // Only the owner manages the link.
    expect(screen.queryByTestId("share-link-controls")).toBeNull();
  });

  it("hands the owner of a private scene its sharing link with the controls to copy, replace or turn it off", () => {
    render(
      <SceneInfoPanel
        {...info}
        isOwner
        pageUrl="https://scenes.frameos.net/s/clock?share=tok"
        scene={{ ...info.scene, visibility: "private" }}
        share="tok"
        signedIn
      />,
    );
    expect((screen.getByTestId("share-link-url") as HTMLInputElement).value).toBe(
      "https://scenes.frameos.net/s/clock?share=tok",
    );
    expect(screen.getByRole("button", { name: "Copy link" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Replace link" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Turn sharing off" })).toBeTruthy();
    expect(screen.getByText(/Anyone with this link can view and install/)).toBeTruthy();
    expect(screen.getByText("Private, shared by link")).toBeTruthy();
    // The scene's own actions sit apart from the link's, last in the column.
    const actions = document.querySelector(".scene-info__owner-actions")!;
    expect(actions.textContent).toContain("Make public");
    expect(actions.textContent).toContain("Delete");
    expect(document.querySelector(".share-link")!.contains(screen.getByRole("button", { name: "Make public" }))).toBe(false);
  });

  it("says so when sharing is off, and offers to turn it back on", () => {
    render(
      <SceneInfoPanel
        {...info}
        isOwner
        scene={{ ...info.scene, visibility: "private" }}
        share={undefined}
        signedIn
      />,
    );
    expect(screen.getByText(/Sharing is off: no link works, only you can see the scene/)).toBeTruthy();
    expect(screen.getByText("Private, only you")).toBeTruthy();
    expect(screen.queryByTestId("share-link-url")).toBeNull();
    expect(screen.getByRole("button", { name: "Turn sharing on" })).toBeTruthy();
    // The rest of the owner controls are still there.
    expect(screen.getByRole("button", { name: "Make public" })).toBeTruthy();
  });

  it("gives the owner the editors, the image controls and the visibility actions — all writing the draft", () => {
    const draft = {
      images: info.images,
      listing: { ...info.versions[0]!.listing },
      onImagesChange: vi.fn(),
      onListingChange: vi.fn(),
    };
    render(
      <SceneInfoPanel
        {...info}
        draft={draft}
        installableFrames={[{ connected: true, id: "f1", name: "Kitchen", status: "active" }]}
        isOwner
        scene={{ ...info.scene, visibility: "private" }}
        signedIn
      />,
    );
    expect(screen.getAllByRole("button", { name: /Remove image \d/ })).toHaveLength(2);
    expect(screen.getByRole("button", { name: /Add an image to this scene/ })).toBeTruthy();
    // Removing goes to the draft, never to the server.
    fireEvent.click(screen.getByRole("button", { name: "Remove image 2" }));
    expect(draft.onImagesChange).toHaveBeenCalledWith([shaA]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Edit description" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Minimum FrameOS version: 2026.8.1 or newer" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Make public" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();
    // No per-version actions here: those are in the bar's versions dialog.
    expect(screen.queryByRole("button", { name: "Unpublish" })).toBeNull();
    expect(screen.getByText("Private, only you")).toBeTruthy();
  });

  it("opens the category editor from the owner's category pill, where a visitor's pill links to the store", () => {
    const draft = {
      images: info.images,
      listing: { ...info.versions[0]!.listing },
      onImagesChange: vi.fn(),
      onListingChange: vi.fn(),
    };
    render(<SceneInfoPanel {...info} draft={draft} isOwner signedIn />);
    // The pill is the button now: no link out of the editor beside it.
    expect(screen.queryByRole("link", { name: "Weather" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Edit category: Weather" }));
    const select = screen.getByLabelText("Category") as HTMLSelectElement;
    expect(select.value).toBe("weather");
    fireEvent.change(select, { target: { value: "calendar" } });
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(draft.onListingChange).toHaveBeenCalledWith({ category: "calendar" });
  });

  it("shows the owner the minimum FrameOS version on its edit button, and sets the current release in one click", () => {
    const draft = {
      images: info.images,
      listing: { ...info.versions[0]!.listing },
      onImagesChange: vi.fn(),
      onListingChange: vi.fn(),
    };
    render(<SceneInfoPanel {...info} draft={draft} isOwner signedIn />);
    fireEvent.click(screen.getByRole("button", { name: "Minimum FrameOS version: 2026.8.1 or newer" }));
    expect((screen.getByLabelText("Minimum FrameOS version") as HTMLInputElement).value).toBe(
      "2026.8.1",
    );
    const current = versions.frameos.split("+")[0]!;
    fireEvent.click(screen.getByRole("button", { name: `Use current version (${current})` }));
    expect(draft.onListingChange).toHaveBeenCalledWith({ frameosVersion: current });
  });

  it("freezes a pulled scene for its owner: the notice, no image controls, only Delete", () => {
    render(
      <SceneInfoPanel
        {...info}
        draft={{
          images: info.images,
          listing: info.versions[0]!.listing,
          onImagesChange: vi.fn(),
          onListingChange: vi.fn(),
        }}
        isOwner
        scene={{ ...info.scene, pulledReason: "malware report", status: "pulled" }}
        signedIn
      />,
    );
    const notice = screen.getByRole("alert");
    expect(notice.textContent).toContain("Pulled");
    expect(notice.textContent).toContain("pulled by moderation");
    expect(notice.textContent).toContain("malware report");
    // The images still render (the owner's session may read them) but the
    // server refuses edits on a pulled scene, so no add/remove buttons.
    expect(document.querySelectorAll(".scene-gallery img")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: /Remove image/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Add an image to this scene/ })).toBeNull();
    // The way out is deleting the scene; visibility cannot be flipped.
    expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Make (public|private)/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Report scene" })).toBeNull();
  });

  it("heads the column with the name it is given as a heading, the publisher line under it, then the description, then the images", () => {
    render(<SceneInfoPanel {...info} heading={<span>Clock title</span>} />);
    const heading = screen.getByRole("heading", { level: 1, name: "Clock title" });
    const byline = screen.getByText(/12 downloads/);
    const description = screen.getByText("station").closest(".section-block")!;
    const gallery = document.querySelector(".scene-gallery")!;
    const header = document.querySelector(".scene-info")!.firstElementChild!;
    expect(header.contains(heading)).toBe(true);
    expect(header.contains(byline)).toBe(true);
    expect(heading.compareDocumentPosition(byline) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(byline.compareDocumentPosition(description) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(description.compareDocumentPosition(gallery) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Thumbnails open the lightbox.
    fireEvent.click(screen.getByRole("button", { name: "View image 2 full size" }));
    expect(
      screen.getByRole("dialog", { name: "Scene image" }).querySelector("img")?.getAttribute("src"),
    ).toBe(`/api/store/scenes/scene-1/images/${shaB}`);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows a pinned version's own listing and images when told to", () => {
    render(<SceneInfoPanel {...info} shown={{ images: info.versions[1]!.images, listing: info.versions[1]!.listing }} />);
    expect(screen.getByText("An old clock.")).toBeTruthy();
    expect(screen.queryByText(/requires FrameOS/)).toBeNull();
    expect(screen.getAllByRole("button", { name: /View image \d full size/ })).toHaveLength(1);
    expect(screen.queryByRole("link", { name: "Weather" })).toBeNull();
  });

  it("has no heading element when it is given none", () => {
    render(<SceneInfoPanel {...info} />);
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
  });
});

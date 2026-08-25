// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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

function versionsTable() {
  return screen.getByRole("table");
}

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
  it("shows the publisher line, gallery, description, install instructions and versions from its props", () => {
    render(<SceneInfoPanel {...info} onSelectVersion={vi.fn()} viewingVersion={2} />);

    expect(screen.getByText(/12 downloads/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Marius" }).getAttribute("href")).toBe("/publishers/acc-1");
    expect(screen.getByText(/requires FrameOS 2026.8.1 or newer/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Report scene" })).toBeTruthy();

    // Gallery: the zip's preview plus the uploaded image (thumbnails are
    // decorative, alt=""); the main image zooms, it is not a link anywhere.
    expect(screen.getByRole("button", { name: "Clock preview" })).toBeTruthy();
    expect(document.querySelectorAll(".scene-gallery img")).toHaveLength(3);
    expect(screen.queryByRole("link", { name: "Clock preview" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();

    // Category and tags link into the store.
    expect(screen.getByRole("link", { name: "Weather" }).getAttribute("href")).toBe("/?category=weather");
    expect(screen.getByRole("link", { name: "e-ink" }).getAttribute("href")).toBe("/?tag=e-ink");

    // Description as markdown; no owner editors.
    expect(screen.getByText("station").tagName).toBe("STRONG");
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();

    // Self-hosted install with the page URL; no cloud frames box.
    expect(screen.getByRole("heading", { name: "Install on your FrameOS" })).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "URL to copy" }) as HTMLInputElement).value).toBe(
      "https://scenes.frameos.net/s/clock",
    );
    expect(screen.queryByRole("heading", { name: "Install on a frame" })).toBeNull();

    // Versions: newest first, the latest flagged, the previewed one marked.
    const rows = within(versionsTable()).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByRole("link", { name: "v2" }).getAttribute("href")).toBe(
      "/s/clock?version=2",
    );
    expect(within(rows[0]!).getByText("Latest")).toBeTruthy();
    expect(within(rows[0]!).getByText("Previewing")).toBeTruthy();
    expect(within(rows[0]!).getByText("FrameOS 2026.8.1+")).toBeTruthy();
    expect(within(rows[1]!).getByText("Published")).toBeTruthy();
    expect(within(rows[1]!).getByText("1.0 KB")).toBeTruthy();
    expect(within(rows[1]!).getByText("any FrameOS")).toBeTruthy();
    expect(within(rows[1]!).getByText("0123456789ab…").getAttribute("title")).toBe(
      "SHA-256 0123456789abcdef0123456789abcdef",
    );
    // Three columns that wrap within the panel: no inner scroll container.
    expect(within(versionsTable()).getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual([
      "Version",
      "Published",
    ]);
    expect(versionsTable().closest(".table-scroll")).toBeNull();
    expect(versionsTable().parentElement?.tagName).toBe("SECTION");
  });

  it("puts the gallery first, above the publisher line", () => {
    render(<SceneInfoPanel {...info} viewingVersion={2} />);
    const gallery = document.querySelector(".scene-gallery")!;
    const publisher = screen.getByText(/12 downloads/);
    expect(gallery.compareDocumentPosition(publisher) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(document.querySelector(".scene-info")?.firstElementChild).toBe(gallery);
  });

  it("keeps to thumbnails while the Preview panel is open, each opening the lightbox", () => {
    render(<SceneInfoPanel {...info} previewOpen viewingVersion={2} />);
    // No main image; one thumbnail per image (the zip's preview, the upload).
    expect(screen.queryByRole("button", { name: "Clock preview" })).toBeNull();
    expect(document.querySelectorAll(".scene-gallery img")).toHaveLength(2);
    const thumbs = screen.getAllByRole("button", { name: /View image \d full size/ });
    expect(thumbs).toHaveLength(2);
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(thumbs[1]!);
    const dialog = screen.getByRole("dialog", { name: "Scene image" });
    expect(dialog.querySelector("img")?.getAttribute("src")).toBe("/api/store/scenes/scene-1/images/img-1");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("gives the owner the versions' actions in the compact table", () => {
    render(<SceneInfoPanel {...info} isOwner signedIn viewingVersion={2} />);
    expect(within(versionsTable()).getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual([
      "Version",
      "Published",
      "Action",
    ]);
    const rows = within(versionsTable()).getAllByRole("row").slice(1);
    expect(within(rows[0]!).getByRole("button", { name: "Unpublish" })).toBeTruthy();
    expect(within(rows[0]!).getByText("Previewing")).toBeTruthy();
  });

  it("hands a version click to the callback instead of navigating", () => {
    const onSelectVersion = vi.fn();
    render(<SceneInfoPanel {...info} onSelectVersion={onSelectVersion} viewingVersion={null} />);
    const link = screen.getByRole("link", { name: "v1" });
    // Still a real link (open in a new tab pins the page to that version)…
    expect(link.getAttribute("href")).toBe("/s/clock?version=1");
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    fireEvent(link, click);
    // …but a plain click goes to the Preview panel.
    expect(onSelectVersion).toHaveBeenCalledWith(1);
    expect(click.defaultPrevented).toBe(true);
    expect(window.location.search).toBe("");
    expect(screen.queryByText("Previewing")).toBeNull();
  });

  it("keeps the share token on every link of a private scene, and explains it", () => {
    render(
      <SceneInfoPanel
        {...info}
        scene={{ ...info.scene, visibility: "private" }}
        share="tok"
        viewingVersion={2}
      />,
    );
    expect(screen.getByRole("link", { name: "v1" }).getAttribute("href")).toBe(
      "/s/clock?version=1&share=tok",
    );
    expect(screen.getByRole("button", { name: "Clock preview" }).querySelector("img")?.getAttribute("src")).toBe(
      "/api/store/scenes/scene-1/image?share=tok",
    );
    expect(screen.getByText(/viewing it through a sharing link/)).toBeTruthy();
    expect(screen.getByText(/carries a sharing secret/)).toBeTruthy();
    // A private scene cannot be reported.
    expect(screen.queryByRole("button", { name: "Report scene" })).toBeNull();
  });

  it("gives the owner the editors, the visibility actions and the frames box", () => {
    render(
      <SceneInfoPanel
        {...info}
        installableFrames={[{ connected: true, id: "f1", name: "Kitchen", status: "active" }]}
        isOwner
        scene={{ ...info.scene, visibility: "private" }}
        signedIn
        viewingVersion={1}
      />,
    );
    expect(screen.getByRole("button", { name: "Remove" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit tags" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit category" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Edit minimum FrameOS version/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Make public" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Unpublish" })).toHaveLength(2);
    expect(screen.getByRole("heading", { name: "Install on a frame" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Install on a self-hosted FrameOS" })).toBeTruthy();
    expect(screen.getByText(/only visible to you/)).toBeTruthy();
  });

  it("installs the previewed version when it is not the latest", () => {
    fetchMock.mockResolvedValueOnce(Response.json({ connected: true }));
    render(
      <SceneInfoPanel
        {...info}
        installableFrames={[{ connected: true, id: "f1", name: "Kitchen", status: "active" }]}
        onSelectVersion={vi.fn()}
        signedIn
        viewingVersion={1}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/frames/f1/scenes/add",
      expect.objectContaining({ body: JSON.stringify({ scene_id: "scene-1", scene_version: 1 }) }),
    );
  });
});

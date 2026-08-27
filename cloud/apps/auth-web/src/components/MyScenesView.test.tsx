// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MyScenesView,
  myScenesViewStorageKey,
  type MyScenesRow,
} from "./MyScenesView";

const { fetchMock, refreshMock } = vi.hoisted(() => ({
  fetchMock: vi.fn<typeof fetch>(),
  refreshMock: vi.fn(),
}));

// The grid cards carry the owner "..." menu, which talks to the router and
// PostHog.
vi.mock("next/navigation", () => ({
  usePathname: () => "/my-scenes",
  useRouter: () => ({ refresh: refreshMock, replace: vi.fn() }),
}));

vi.mock("posthog-js", () => ({
  default: { capture: vi.fn() },
}));

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  fetchMock.mockReset();
  refreshMock.mockReset();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

function row(name: string, overrides: Partial<MyScenesRow> = {}): MyScenesRow {
  return {
    category: "weather",
    description: null,
    downloadCount: 3,
    hasPreview: true,
    id: `id-${name}`,
    name,
    slug: name.toLowerCase(),
    status: "active",
    tags: ["time"],
    updatedAt: "2026-08-01T00:00:00.000Z",
    visibility: "private",
    ...overrides,
  };
}

const scenes = [row("Sunrise"), row("Tides", { visibility: "public" })];

function renderView() {
  return render(
    <MyScenesView filters={<form aria-label="Filters" />} scenes={scenes}>
      <table>
        <tbody>
          <tr>
            <td>table row</td>
          </tr>
        </tbody>
      </table>
    </MyScenesView>,
  );
}

describe("MyScenesView", () => {
  it("defaults to the grid: cards with the owner-accessible preview image", () => {
    renderView();

    expect(
      screen
        .getByRole("button", { name: "Grid view" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      screen
        .getByRole("button", { name: "List view" })
        .getAttribute("aria-pressed"),
    ).toBe("false");
    expect(screen.queryByRole("table")).toBeNull();

    const card = screen.getByRole("link", { name: /Sunrise/ });
    expect(card.getAttribute("href")).toBe("/s/sunrise");
    expect(card.querySelector("img")?.getAttribute("src")).toBe(
      "/api/store/scenes/id-Sunrise/image",
    );
    expect(card.textContent).toContain("Private");
    expect(card.textContent).toContain("Weather");
    expect(screen.getByRole("link", { name: /Tides/ }).textContent).toContain(
      "Public",
    );
    // The server-rendered filter form sits next to the toggle in both views.
    expect(screen.getByRole("form", { name: "Filters" })).toBeTruthy();
  });

  it("switches to the table on the list button and remembers the choice", () => {
    renderView();

    fireEvent.click(screen.getByRole("button", { name: "List view" }));

    expect(screen.getByRole("table")).toBeTruthy();
    expect(screen.getByText("table row")).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Sunrise/ })).toBeNull();
    expect(
      screen
        .getByRole("button", { name: "List view" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(window.localStorage.getItem(myScenesViewStorageKey)).toBe("list");

    fireEvent.click(screen.getByRole("button", { name: "Grid view" }));
    expect(window.localStorage.getItem(myScenesViewStorageKey)).toBe("grid");
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("reads a stored list preference back on mount", () => {
    window.localStorage.setItem(myScenesViewStorageKey, "list");
    renderView();

    expect(screen.getByRole("table")).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "List view" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("splits the unfiltered grid into Private and Public sections", () => {
    render(
      <MyScenesView
        grouped
        scenes={[
          ...scenes,
          row("Storm", { status: "pulled", visibility: "public" }),
        ]}
      />,
    );

    const headings = Array.from(
      document.querySelectorAll(".scene-group__heading"),
    );
    expect(headings.map((heading) => heading.textContent)).toEqual([
      "Private scenes1",
      "Public scenes2",
    ]);
    // The owner's own drafts first, then what the world sees; a pulled scene
    // stays in its visibility group but its pill says "Pulled" rather than a
    // visibility that no longer applies.
    const cards = screen.getAllByRole("link");
    expect(cards.map((card) => card.textContent?.slice(0, 5))).toEqual([
      "Sunri",
      "Tides",
      "Storm",
    ]);
    expect(screen.getByRole("link", { name: /Storm/ }).textContent).toContain(
      "Pulled",
    );
    expect(
      screen.getByRole("link", { name: /Storm/ }).textContent,
    ).not.toContain("Public");
  });

  it("gives each grid card a menu with the owner actions", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    fetchMock.mockResolvedValueOnce(Response.json({ ok: true }));
    render(
      <MyScenesView
        scenes={[
          ...scenes,
          row("Storm", { status: "pulled", visibility: "public" }),
        ]}
      />,
    );

    // The card stays one link; the menu button sits beside it.
    const card = screen.getByRole("link", { name: /Sunrise/ });
    expect(card.querySelector("button")).toBeNull();
    const trigger = screen.getByRole("button", {
      name: "More actions for Sunrise",
    });
    expect(screen.queryByRole("menu")).toBeNull();

    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent),
    ).toEqual(["Make public", "Delete"]);

    fireEvent.click(screen.getByRole("menuitem", { name: "Make public" }));
    await vi.waitFor(() => {
      expect(refreshMock).toHaveBeenCalled();
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/account/scenes/id-Sunrise",
      expect.objectContaining({
        body: JSON.stringify({ visibility: "public" }),
        method: "PATCH",
      }),
    );
    // The menu closes once the action went through.
    expect(screen.queryByRole("menu")).toBeNull();

    // A public scene offers the reverse; a pulled one only Delete.
    fireEvent.click(
      screen.getByRole("button", { name: "More actions for Tides" }),
    );
    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent),
    ).toEqual(["Make private", "Delete"]);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "More actions for Storm" }),
    );
    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent),
    ).toEqual(["Delete"]);
  });

  it("keeps a flat grid without headings when not grouped", () => {
    renderView();
    expect(document.querySelector(".scene-group__heading")).toBeNull();
  });

  it("shows the children (empty state) when there are no scenes", () => {
    render(
      <MyScenesView scenes={[]}>
        <p>Nothing published yet.</p>
      </MyScenesView>,
    );
    expect(screen.getByText("Nothing published yet.")).toBeTruthy();
  });
});

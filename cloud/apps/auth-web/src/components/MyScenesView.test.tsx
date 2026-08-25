// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  MyScenesView,
  myScenesViewStorageKey,
  type MyScenesRow,
} from "./MyScenesView";

afterEach(() => {
  cleanup();
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

  it("shows the children (empty state) when there are no scenes", () => {
    render(
      <MyScenesView scenes={[]}>
        <p>Nothing published yet.</p>
      </MyScenesView>,
    );
    expect(screen.getByText("Nothing published yet.")).toBeTruthy();
  });
});

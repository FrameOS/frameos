// @vitest-environment jsdom
//
// The admin tables sort on a header click: once ascending, again
// descending, a third time back to the page's own order; missing values
// stay at the bottom either way, and a grouped table (the trial balance)
// sorts inside each group.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SortableTable, sortRows } from "./SortableTable";

afterEach(cleanup);

function firstColumn(): string[] {
  return screen
    .getAllByRole("row")
    .filter((row) => row.querySelector("td"))
    .map((row) => row.querySelector("td")!.textContent ?? "");
}

const columns = [
  { key: "name", label: "Name" },
  { key: "seen", label: "Last seen" },
  { key: "actions", label: "Actions", sortable: false },
];

const rows = [
  { cells: ["kitchen", "yesterday", "…"], key: "a", sort: ["kitchen", 2, null] },
  { cells: ["Attic", "never", "…"], key: "b", sort: ["Attic", null, null] },
  { cells: ["bedroom", "today", "…"], key: "c", sort: ["bedroom", 3, null] },
  { cells: ["Hall", "last week", "…"], key: "d", sort: ["Hall", 1, null] },
];

describe("sortRows", () => {
  it("orders strings without regard to case and numbers numerically", () => {
    expect(sortRows(rows, 0, "asc").map((row) => row.key)).toEqual(["b", "c", "d", "a"]);
    expect(sortRows(rows, 0, "desc").map((row) => row.key)).toEqual(["a", "d", "c", "b"]);
    expect(sortRows(rows, 1, "asc").map((row) => row.key)).toEqual(["d", "a", "c", "b"]);
  });

  it("keeps missing values last in both directions", () => {
    expect(sortRows(rows, 1, "desc").map((row) => row.key)).toEqual(["c", "a", "d", "b"]);
  });

  it("compares version strings by their numeric parts", () => {
    const versions = ["2026.10.9", "2026.10.13", "2026.9.30"].map((version) => ({
      cells: [version],
      key: version,
      sort: [version],
    }));
    expect(sortRows(versions, 0, "asc").map((row) => row.key)).toEqual([
      "2026.9.30",
      "2026.10.9",
      "2026.10.13",
    ]);
  });
});

describe("SortableTable", () => {
  it("cycles a column through ascending, descending and the original order", () => {
    render(<SortableTable columns={columns} rows={rows} />);
    expect(firstColumn()).toEqual(["kitchen", "Attic", "bedroom", "Hall"]);

    const header = screen.getByRole("button", { name: /Name/ });
    fireEvent.click(header);
    expect(firstColumn()).toEqual(["Attic", "bedroom", "Hall", "kitchen"]);
    expect(header.closest("th")?.getAttribute("aria-sort")).toBe("ascending");

    fireEvent.click(header);
    expect(firstColumn()).toEqual(["kitchen", "Hall", "bedroom", "Attic"]);
    expect(header.closest("th")?.getAttribute("aria-sort")).toBe("descending");

    fireEvent.click(header);
    expect(firstColumn()).toEqual(["kitchen", "Attic", "bedroom", "Hall"]);
    expect(header.closest("th")?.hasAttribute("aria-sort")).toBe(false);
  });

  it("switching columns starts the new one ascending", () => {
    render(<SortableTable columns={columns} rows={rows} />);
    fireEvent.click(screen.getByRole("button", { name: /Name/ }));
    fireEvent.click(screen.getByRole("button", { name: /Last seen/ }));
    expect(firstColumn()).toEqual(["Hall", "kitchen", "bedroom", "Attic"]);
  });

  it("gives an unsortable column a plain header", () => {
    render(<SortableTable columns={columns} rows={rows} />);
    expect(screen.queryByRole("button", { name: /Actions/ })).toBeNull();
    expect(screen.getByText("Actions").tagName).toBe("TH");
  });

  it("sorts grouped rows inside their group and keeps the group order", () => {
    const grouped = [
      { cells: ["b"], group: "Assets", key: "1", sort: [2] },
      { cells: ["a"], group: "Assets", key: "2", sort: [1] },
      { cells: ["d"], group: "Revenue", key: "3", sort: [4] },
      { cells: ["c"], group: "Revenue", key: "4", sort: [3] },
    ];
    render(<SortableTable columns={[{ key: "x", label: "X" }]} rows={grouped} />);
    fireEvent.click(screen.getByRole("button", { name: /X/ }));
    expect(firstColumn()).toEqual(["a", "b", "c", "d"]);
    const headings = [...document.querySelectorAll("tbody th")].map((cell) => cell.textContent);
    expect(headings).toEqual(["Assets", "Revenue"]);
  });
});

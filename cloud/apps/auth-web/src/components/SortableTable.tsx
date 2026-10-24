"use client";

import { type ReactNode, useMemo, useState } from "react";

// One table for every admin list: the page renders each cell on the server
// (links, pills, buttons — anything a cell held before) and hands the rows
// over with a sort value per column; clicking a header sorts what the page
// already fetched, here in the browser. Nothing is re-queried: the lists are
// capped at the page's own limit, and a sort that re-fetched would make the
// "first 200" caption a lie.
//
// Rows are passed as data rather than children on purpose. The component
// needs a sort value per cell, and reading one back out of rendered markup
// (a formatted date, "1.2 GB", "3/5") is what makes a sortable table sort
// wrong.

export type SortValue = string | number | boolean | null | undefined;

export type SortableColumn = {
  // Right-aligned columns are numbers; the header's button follows suit.
  align?: "right" | undefined;
  key: string;
  label: ReactNode;
  // A header that is not a sort key — "Actions", a column of buttons.
  sortable?: boolean | undefined;
  title?: string | undefined;
};

export type SortableRow = {
  cells: ReactNode[];
  className?: string | undefined;
  // Rows with a group render in per-group bodies (the trial balance's
  // account groups) and sort within their group; group order is the order
  // of first appearance.
  group?: string | undefined;
  key: string | number;
  // One value per column, in column order. Missing values sort last on
  // either direction, so a column of "never" seen frames never leads.
  sort: SortValue[];
};

type SortState = { direction: "asc" | "desc"; key: string };

function compareValues(a: SortValue, b: SortValue): number {
  const aMissing = a === null || a === undefined || a === "";
  const bMissing = b === null || b === undefined || b === "";
  if (aMissing || bMissing) {
    return aMissing === bMissing ? 0 : aMissing ? 1 : -1;
  }
  if (typeof a === "number" && typeof b === "number") {
    return a - b;
  }
  if (typeof a === "boolean" && typeof b === "boolean") {
    return Number(b) - Number(a);
  }
  return String(a).localeCompare(String(b), undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

export function sortRows<Row extends SortableRow>(
  rows: Row[],
  columnIndex: number,
  direction: "asc" | "desc",
): Row[] {
  // Stable: ties keep the page's own order (its "newest first", "biggest
  // first"), which is what a reader expects of a secondary order.
  const indexed = rows.map((row, index) => ({ index, row }));
  indexed.sort((left, right) => {
    const a = left.row.sort[columnIndex];
    const b = right.row.sort[columnIndex];
    const aMissing = a === null || a === undefined || a === "";
    const bMissing = b === null || b === undefined || b === "";
    // Missing values stay last whichever way the column points.
    if (aMissing || bMissing) {
      const byMissing = compareValues(a, b);
      return byMissing !== 0 ? byMissing : left.index - right.index;
    }
    const compared = compareValues(a, b);
    if (compared !== 0) {
      return direction === "asc" ? compared : -compared;
    }
    return left.index - right.index;
  });
  return indexed.map((entry) => entry.row);
}

export function SortableTable({
  columns,
  foot,
  rows,
}: {
  columns: SortableColumn[];
  foot?: ReactNode;
  rows: SortableRow[];
}) {
  const [sort, setSort] = useState<SortState | undefined>();

  const sorted = useMemo(() => {
    if (!sort) {
      return rows;
    }
    const columnIndex = columns.findIndex((column) => column.key === sort.key);
    return columnIndex < 0 ? rows : sortRows(rows, columnIndex, sort.direction);
  }, [columns, rows, sort]);

  const groups = useMemo(() => {
    const grouped = sorted.some((row) => row.group !== undefined);
    if (!grouped) {
      return [{ label: undefined, rows: sorted }];
    }
    const order: string[] = [];
    const byGroup = new Map<string, SortableRow[]>();
    for (const row of sorted) {
      const label = row.group ?? "";
      if (!byGroup.has(label)) {
        order.push(label);
        byGroup.set(label, []);
      }
      byGroup.get(label)!.push(row);
    }
    return order.map((label) => ({ label, rows: byGroup.get(label)! }));
  }, [sorted]);

  function toggle(key: string) {
    // Click once for ascending, again for descending, a third time to get
    // the page's own order back.
    setSort((current) => {
      if (current?.key !== key) {
        return { direction: "asc", key };
      }
      return current.direction === "asc" ? { direction: "desc", key } : undefined;
    });
  }

  return (
    <div className="table-scroll">
      <table className="table">
        <thead>
          <tr>
            {columns.map((column) => {
              const active = sort?.key === column.key;
              const sortable = column.sortable !== false;
              const style = column.align === "right" ? { textAlign: "right" as const } : undefined;
              return (
                <th
                  aria-sort={
                    active ? (sort.direction === "asc" ? "ascending" : "descending") : undefined
                  }
                  key={column.key}
                  style={style}
                  title={column.title}
                >
                  {sortable ? (
                    <button
                      className={`table-sort${active ? " table-sort--active" : ""}`}
                      onClick={() => toggle(column.key)}
                      type="button"
                    >
                      {column.label}
                      <span aria-hidden className="table-sort__mark">
                        {active ? (sort.direction === "asc" ? "▲" : "▼") : "⇅"}
                      </span>
                    </button>
                  ) : (
                    column.label
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        {groups.map((group, groupIndex) => (
          <tbody key={group.label ?? groupIndex}>
            {group.label !== undefined ? (
              <tr>
                <th colSpan={columns.length}>{group.label}</th>
              </tr>
            ) : null}
            {group.rows.map((row) => (
              <tr className={row.className} key={row.key}>
                {row.cells.map((cell, index) => (
                  <td
                    key={columns[index]?.key ?? index}
                    style={columns[index]?.align === "right" ? { textAlign: "right" } : undefined}
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        ))}
        {foot}
      </table>
    </div>
  );
}

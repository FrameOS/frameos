"use client";

import type { StoreBrowseFilters } from "../lib/store-filters";

// The FrameOS version filter, next to the store search. A scene runs on
// every version at or above its declared minimum, so each option's count is
// cumulative. Picking a version submits the surrounding search form (a plain
// GET of "/"), which navigates immediately — like the filter pills this
// replaced — and carries the other filters along as that form's fields; the
// select's own name="version" is what keeps the choice on a plain "Search"
// submit too. No useRouter here: the store front is server-rendered (and
// integration-tested with renderToString), where the app-router context does
// not exist.
export function StoreVersionSelect({
  filters,
  options,
}: {
  filters: StoreBrowseFilters;
  options: { count: number; version: string }[];
}) {
  return (
    <select
      aria-label="Filter by FrameOS version"
      className="store-search__select"
      defaultValue={filters.version}
      name="version"
      onChange={(event) => event.currentTarget.form?.requestSubmit()}
    >
      <option value="">All FrameOS versions</option>
      {options.map((option) => (
        <option key={option.version} value={option.version}>
          FrameOS {option.version} ({option.count})
        </option>
      ))}
    </select>
  );
}

"use client";

import { useRouter } from "next/navigation";
import { storeBrowseHref, type StoreBrowseFilters } from "../lib/store-filters";

// The FrameOS version filter, next to the store search. A scene runs on
// every version at or above its declared minimum, so each option's count is
// cumulative. Picking a version navigates immediately (like the filter pills
// this replaced); it also carries name="version" so a plain "Search" submit
// keeps the current choice.
export function StoreVersionSelect({
  filters,
  options,
}: {
  filters: StoreBrowseFilters;
  options: { count: number; version: string }[];
}) {
  const router = useRouter();
  return (
    <select
      aria-label="Filter by FrameOS version"
      className="store-search__select"
      defaultValue={filters.version}
      name="version"
      onChange={(event) =>
        router.push(storeBrowseHref({ ...filters, version: event.target.value }))
      }
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

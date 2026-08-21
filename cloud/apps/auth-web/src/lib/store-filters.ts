import { getStoreCategory } from "./categories";
import { normalizeRequestedFrameosVersion } from "./store-versions";

// The store listing's filter state, shared by the server-rendered page, the
// lazy feed in the browser, and the /api/store/browse route. Dependency-free
// on purpose: this module is imported by client components, so it must not
// drag drizzle or the database client into the browser bundle.

export const storePageSize = 48;

// Hundreds of scenes are expected; nothing may load them all at once, and no
// crawler may walk us into a million-row offset either.
export const maxStorePage = 200;

export type StoreBrowseFilters = {
  category: string;
  query: string;
  tag: string;
  version: string;
};

export type StoreBrowseParams = {
  category?: string | undefined;
  page?: string | undefined;
  q?: string | undefined;
  tag?: string | undefined;
  version?: string | undefined;
};

// Normalizes untrusted search params. Unknown categories and malformed
// versions are dropped rather than rejected: a stale link keeps working, it
// just stops filtering.
export function parseStoreBrowseFilters(
  params: StoreBrowseParams,
): StoreBrowseFilters {
  return {
    category:
      getStoreCategory(params.category?.trim().toLowerCase())?.slug ?? "",
    query: params.q?.trim().slice(0, 100) ?? "",
    tag: params.tag?.trim().toLowerCase().slice(0, 24) ?? "",
    version: normalizeRequestedFrameosVersion(params.version) ?? "",
  };
}

export function parseStorePage(value: string | undefined | null) {
  const page = Math.max(1, Number.parseInt(value ?? "1", 10) || 1);
  return Math.min(page, maxStorePage);
}

// The canonical query string for a filtered listing, so links, the pager and
// the lazy feed all agree on the URL shape.
export function storeBrowseSearchParams(
  filters: StoreBrowseFilters,
  page = 1,
): URLSearchParams {
  const search = new URLSearchParams();
  if (filters.query) {
    search.set("q", filters.query);
  }
  if (filters.tag) {
    search.set("tag", filters.tag);
  }
  if (filters.category) {
    search.set("category", filters.category);
  }
  if (filters.version) {
    search.set("version", filters.version);
  }
  if (page > 1) {
    search.set("page", String(page));
  }
  return search;
}

// A store-front URL with the given filters (and optional page).
// `basePath` is the store front's path — "/" on its own host, "/store" when
// it shares the cloud origin (env.ts getStorePath()).
export function storeBrowseHref(
  filters: StoreBrowseFilters,
  page = 1,
  basePath = "/",
) {
  const suffix = storeBrowseSearchParams(filters, page).toString();
  return suffix ? `${basePath}?${suffix}` : basePath;
}

// The same URL with one filter flipped — clicking an active pill clears it.
export function storeFilterHref(
  filters: StoreBrowseFilters,
  change: Partial<StoreBrowseFilters>,
  basePath = "/",
) {
  return storeBrowseHref({ ...filters, ...change }, 1, basePath);
}

export function storeHasFilters(filters: StoreBrowseFilters) {
  return Boolean(
    filters.category || filters.query || filters.tag || filters.version,
  );
}

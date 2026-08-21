"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { SceneCard } from "./SceneCard";
import type { StoreBrowseScene } from "../lib/store-browse";
import {
  storeBrowseHref,
  storeBrowseSearchParams,
  type StoreBrowseFilters,
} from "../lib/store-filters";

// The lazy half of the store listing. The server renders the first page (or,
// on the curated front page, the category shelves) and hands it to this
// component; everything after that is fetched a page at a time from
// /api/store/browse when the sentinel below scrolls into view.
//
// Without JavaScript this degrades to the plain pager it replaces: the
// Previous/Next links are what renders on the server, and the button only
// takes over once the component has mounted in a browser.
export function StoreSceneFeed({
  basePath = "/",
  filters,
  heading,
  initialScenes,
  loadedPage,
  totalPages,
}: {
  // The store front's path, for the no-JS pager links (env.ts getStorePath()).
  basePath?: string;
  filters: StoreBrowseFilters;
  // Shown above the appended cards when the server rendered something else
  // above them (the shelves on the unfiltered front page).
  heading?: string;
  initialScenes: StoreBrowseScene[];
  // The last page already on screen; the feed continues at loadedPage + 1.
  loadedPage: number;
  totalPages: number;
}) {
  const [scenes, setScenes] = useState<StoreBrowseScene[]>([]);
  const [page, setPage] = useState(loadedPage);
  const [exhausted, setExhausted] = useState(loadedPage >= totalPages);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [mounted, setMounted] = useState(false);
  const sentinel = useRef<HTMLDivElement | null>(null);

  useEffect(() => setMounted(true), []);

  // A new filter combination is a new listing: drop whatever was appended for
  // the previous one instead of mixing the two.
  useEffect(() => {
    setScenes([]);
    setPage(loadedPage);
    setExhausted(loadedPage >= totalPages);
    setFailed(false);
  }, [
    filters.category,
    filters.query,
    filters.tag,
    filters.version,
    loadedPage,
    totalPages,
  ]);

  const loadMore = useCallback(async () => {
    if (loading || exhausted) {
      return;
    }
    setLoading(true);
    setFailed(false);
    const next = page + 1;
    try {
      const search = storeBrowseSearchParams(filters, next);
      const response = await fetch(`/api/store/browse?${search.toString()}`);
      if (!response.ok) {
        throw new Error("browse_failed");
      }
      const payload = (await response.json()) as {
        hasMore?: boolean;
        scenes?: StoreBrowseScene[];
      };
      const loaded = payload.scenes ?? [];
      setScenes((current) => {
        const seen = new Set(current.map((scene) => scene.id));
        return [...current, ...loaded.filter((scene) => !seen.has(scene.id))];
      });
      setPage(next);
      if (!payload.hasMore || next >= totalPages) {
        setExhausted(true);
      }
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [exhausted, filters, loading, page, totalPages]);

  // Infinite scroll: load the next page as the sentinel approaches the
  // viewport. The button stays for keyboard users and for retries.
  useEffect(() => {
    const node = sentinel.current;
    if (
      !node ||
      exhausted ||
      failed ||
      typeof IntersectionObserver === "undefined"
    ) {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          void loadMore();
        }
      },
      { rootMargin: "600px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [exhausted, failed, loadMore]);

  const all = [...initialScenes, ...scenes];
  const showHeading = Boolean(heading) && all.length > 0;

  return (
    <>
      {showHeading ? (
        <section className="section-block">
          <h2>{heading}</h2>
        </section>
      ) : null}
      {all.length > 0 ? (
        <div className="grid scene-grid">
          {all.map((scene) => (
            <SceneCard
              key={scene.id}
              scene={{ ...scene, updatedAt: new Date(scene.updatedAt) }}
            />
          ))}
        </div>
      ) : null}

      {mounted ? (
        exhausted ? null : (
          <>
            {/* Trips the observer a little before the end of the list. */}
            <div aria-hidden ref={sentinel} />
            <nav aria-label="Load more scenes" className="store-pager">
              <button
                className="button button--subtle"
                disabled={loading}
                onClick={() => void loadMore()}
                type="button"
              >
                {loading
                  ? "Loading…"
                  : failed
                    ? "Try again"
                    : "Load more scenes"}
              </button>
              {failed ? <span>Could not load more scenes.</span> : null}
            </nav>
          </>
        )
      ) : totalPages > 1 ? (
        // Server-rendered / no-JS fallback: the classic pager, so deep links
        // and crawlers can still walk the whole listing.
        <nav aria-label="Pagination" className="store-pager">
          {loadedPage > 1 ? (
            <Link href={storeBrowseHref(filters, loadedPage - 1, basePath)}>
              ← Previous
            </Link>
          ) : null}
          <span>
            Page {loadedPage} of {totalPages}
          </span>
          {loadedPage < totalPages ? (
            <Link href={storeBrowseHref(filters, loadedPage + 1, basePath)}>
              Next →
            </Link>
          ) : null}
        </nav>
      ) : null}
    </>
  );
}

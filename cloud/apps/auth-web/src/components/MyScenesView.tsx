"use client";

import { LayoutGrid, List } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { SceneCard } from "./SceneCard";

export type MyScenesViewMode = "grid" | "list";

// One row of the signed-in account's scene list, already serialised by the
// server page (dates as ISO strings so the props cross the RSC boundary).
export type MyScenesRow = {
  category: string | null;
  description: string | null;
  downloadCount: number;
  hasPreview: boolean;
  id: string;
  name: string;
  slug: string;
  tags: string[];
  // "active" | "pulled": a pulled scene's card says so instead of its
  // visibility, which no longer means anything while it is pulled.
  status: string;
  updatedAt: string;
  visibility: string;
};

// The visibility groups of the unfiltered list, in display order: what the
// world sees first, then what only the owner sees. Groups without scenes
// are skipped.
export const myScenesGroups = [
  { key: "public", title: "Public scenes" },
  { key: "private", title: "Private scenes" },
] as const;

export type MyScenesGroupKey = (typeof myScenesGroups)[number]["key"];

export function groupMyScenes<T extends { visibility: string }>(scenes: T[]) {
  return myScenesGroups
    .map((group) => ({
      ...group,
      scenes: scenes.filter((scene) =>
        group.key === "public"
          ? scene.visibility === "public"
          : scene.visibility !== "public",
      ),
    }))
    .filter((group) => group.scenes.length > 0);
}

// The heading over one visibility group, shared by the grid and the table
// so both views read the same.
export function MyScenesGroupHeading({
  count,
  title,
}: {
  count: number;
  title: string;
}) {
  return (
    <h3 className="scene-group__heading">
      {title}
      <span className="scene-group__count">{count}</span>
    </h3>
  );
}

export const myScenesViewStorageKey = "frameos:my-scenes-view";

function readStoredView(): MyScenesViewMode | null {
  try {
    const stored = window.localStorage.getItem(myScenesViewStorageKey);
    return stored === "grid" || stored === "list" ? stored : null;
  } catch {
    return null;
  }
}

function storeView(view: MyScenesViewMode) {
  try {
    window.localStorage.setItem(myScenesViewStorageKey, view);
  } catch {
    // Private mode / storage disabled: the choice just does not stick.
  }
}

// The grid / list switch on "My scenes". The grid reuses the store
// front's cards; the list is the server-rendered table handed in as
// `children` (with its owner actions), so it stays exactly as it was. The
// server always renders the grid; a remembered "list" choice takes over after
// mount, which avoids a hydration mismatch at the cost of one repaint.
export function MyScenesView({
  children,
  filters,
  grouped = false,
  scenes,
}: {
  // The table (or the empty-state card when there are no scenes).
  children?: ReactNode | undefined;
  // The server-rendered filter form, laid out left of the toggle.
  filters?: ReactNode | undefined;
  // Split the grid into Public / Private sections (the unfiltered list);
  // the page groups the table the same way.
  grouped?: boolean | undefined;
  scenes: MyScenesRow[];
}) {
  const [view, setView] = useState<MyScenesViewMode>("grid");

  useEffect(() => {
    const stored = readStoredView();
    if (stored) {
      setView(stored);
    }
  }, []);

  function choose(next: MyScenesViewMode) {
    setView(next);
    storeView(next);
  }

  return (
    <>
      <div className="my-scenes-toolbar">
        {filters}
        <div aria-label="View" className="view-toggle" role="group">
          <button
            aria-label="Grid view"
            aria-pressed={view === "grid"}
            className="view-toggle__button"
            onClick={() => choose("grid")}
            title="Grid view"
            type="button"
          >
            <LayoutGrid aria-hidden size={16} />
          </button>
          <button
            aria-label="List view"
            aria-pressed={view === "list"}
            className="view-toggle__button"
            onClick={() => choose("list")}
            title="List view"
            type="button"
          >
            <List aria-hidden size={16} />
          </button>
        </div>
      </div>
      {view === "grid" && scenes.length > 0 ? (
        grouped ? (
          groupMyScenes(scenes).map((group) => (
            <section className="scene-group" key={group.key}>
              <MyScenesGroupHeading
                count={group.scenes.length}
                title={group.title}
              />
              <SceneGrid scenes={group.scenes} />
            </section>
          ))
        ) : (
          <SceneGrid scenes={scenes} />
        )
      ) : (
        children
      )}
    </>
  );
}

function SceneGrid({ scenes }: { scenes: MyScenesRow[] }) {
  return (
    <div className="grid scene-grid">
      {scenes.map((scene) => (
        <SceneCard
          key={scene.id}
          scene={{ ...scene, updatedAt: new Date(scene.updatedAt) }}
        />
      ))}
    </div>
  );
}

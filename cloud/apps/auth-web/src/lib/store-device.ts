import { and, desc, eq, isNotNull, sql, type SQL } from "drizzle-orm";
import { accounts, createDb, storeScenes } from "@frameos-cloud/db";
import { storeCategories } from "./categories";
import { storeBrowseConditions } from "./store-browse";
import type { StoreBrowseFilters } from "./store-filters";

// The store as a frame reads it on its own screen (docs/scene-store-on-frame.md):
// the scene switcher's "Scene store" page lists a page of scenes, and the
// long press on an installed one asks for its newest version. A frame can be
// an ESP32 with a few hundred KB of internal RAM parsing this with the whole
// scene running next to it, so the answer is small on purpose: a dozen scenes
// a page, five short keys each, no descriptions, tags, images or counts. The
// browser's /api/store/browse is the same query with the card's fields.
//
// Only what a frame is offered: public, active, filed under a category (the
// "Other scenes" shelf is where unverified uploads wait, as for the
// repository index), and never a scene whose newest version runs shell
// commands, which no control plane pushes to a frame.

type Database = ReturnType<typeof createDb>;

export const storeDevicePageSize = 12;
const maxNameLength = 80;
const maxByLength = 40;
const maxDescriptionLength = 280;

export type StoreDeviceScene = {
  id: string;
  name: string;
  category: string | null;
  version: number;
  by: string;
};

export type StoreDeviceSceneInfo = StoreDeviceScene & { description: string };

function storeDeviceConditions(filters: StoreBrowseFilters): SQL[] {
  return [
    ...storeBrowseConditions(filters),
    isNotNull(storeScenes.category),
    sql`not (${storeScenes.riskFlags} @> array['shell']::text[])`,
  ];
}

// Cut on a code point, never inside a surrogate pair: what the frame shows
// is drawn glyph by glyph.
function clip(text: string | null | undefined, max: number): string {
  const chars = Array.from((text ?? "").replace(/\s+/g, " ").trim());
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : chars.join("");
}

function deviceScene(row: {
  category: string | null;
  id: string;
  latestVersion: number;
  name: string;
  publisher: string | null;
}): StoreDeviceScene {
  return {
    by: clip(row.publisher, maxByLength),
    category: row.category,
    id: row.id,
    name: clip(row.name, maxNameLength),
    version: row.latestVersion,
  };
}

export async function listStoreScenesForDevice(
  db: Database,
  filters: StoreBrowseFilters,
  page: number,
): Promise<{ scenes: StoreDeviceScene[]; more: boolean }> {
  // One row past the page says whether there is another, without a count.
  const rows = await db
    .select({
      category: storeScenes.category,
      id: storeScenes.id,
      latestVersion: storeScenes.latestVersion,
      name: storeScenes.name,
      publisher: accounts.displayName,
    })
    .from(storeScenes)
    .innerJoin(accounts, eq(accounts.id, storeScenes.accountId))
    .where(and(...storeDeviceConditions(filters)))
    .orderBy(
      sql`${storeScenes.featuredAt} desc nulls last`,
      desc(storeScenes.downloadCount),
      desc(storeScenes.updatedAt),
      storeScenes.id,
    )
    .limit(storeDevicePageSize + 1)
    .offset((page - 1) * storeDevicePageSize);
  return {
    more: rows.length > storeDevicePageSize,
    scenes: rows.slice(0, storeDevicePageSize).map(deviceScene),
  };
}

// One scene a frame may be offered, with a short description: what the frame
// shows for an installed store scene, and the version an update would bring.
export async function storeSceneForDevice(
  db: Database,
  sceneId: string,
): Promise<StoreDeviceSceneInfo | null> {
  const [row] = await db
    .select({
      category: storeScenes.category,
      description: storeScenes.description,
      id: storeScenes.id,
      latestVersion: storeScenes.latestVersion,
      name: storeScenes.name,
      publisher: accounts.displayName,
    })
    .from(storeScenes)
    .innerJoin(accounts, eq(accounts.id, storeScenes.accountId))
    .where(and(eq(storeScenes.id, sceneId), ...storeDeviceConditions({ category: "", query: "", tag: "", version: "" })))
    .limit(1);
  if (!row) {
    return null;
  }
  return { ...deviceScene(row), description: clip(row.description, maxDescriptionLength) };
}

// The shelves, in the store front's order, as slug and title alone.
export function storeDeviceCategories(): { slug: string; title: string }[] {
  return storeCategories.map((category) => ({ slug: category.slug, title: category.title }));
}

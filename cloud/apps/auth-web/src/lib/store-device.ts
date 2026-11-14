import { and, desc, eq, isNotNull, notInArray, sql, type SQL } from "drizzle-orm";
import { accounts, createDb, storeScenes } from "@frameos-cloud/db";
import { storeCategories } from "./categories";
import { storeBrowseConditions } from "./store-browse";
import { deviceCoverUrls } from "./store-device-covers";
import { sceneCoverObjectKeySql, sceneHasImageSql } from "./store-listing";
import type { StoreBrowseFilters } from "./store-filters";

// The store as a frame reads it (docs/scene-store.md): the Scene store scene
// on a frame lists a page of scenes at a time, through its host
// (frameos.storeAction("browse")) or straight from the app. A frame can be an
// ESP32 parsing this in JavaScript with the whole scene running next to it,
// so the answer is small on purpose: a page the size of the app's grid, short
// keys, a description cut to a line or two, the cover as a path and no tags
// or counts. The browser's /api/store/browse is the same query with the
// card's fields.
//
// Only what a frame is offered: public, active, filed under a category (the
// "Other scenes" shelf is where unverified uploads wait, as for the
// repository index), and never a scene whose newest version runs shell
// commands, which no control plane pushes to a frame.

type Database = ReturnType<typeof createDb>;

export const storeDevicePageSize = 12;
export const storeDeviceMaxPageSize = 24;
const maxNameLength = 80;
const maxByLength = 40;
const maxAboutLength = 140;
const maxDescriptionLength = 280;

export type StoreDeviceScene = {
  id: string;
  name: string;
  category: string | null;
  version: number;
  by: string;
  // The description, cut to a line or two for a card.
  about: string;
  // The cover, as a path on this host (`/api/store/scenes/{id}/image?version=N`):
  // null for a scene without one.
  image: string | null;
  // The cover as a JPEG of at most 512 px, a URL on the store's CDN: what a
  // card needs, a tenth of the cover's bytes or less (store-device-covers.ts).
  // null without a cover, or where the store has no CDN.
  thumb: string | null;
};

export type StoreDeviceSceneInfo = StoreDeviceScene & { description: string };

// What a frame asks beyond the store front's filters: how many a page (its
// grid), a shelf to put first (a fast panel puts "realtime" first) and shelves
// to leave out (e-paper leaves "realtime" out).
export type StoreDeviceOptions = {
  limit?: number;
  prefer?: string;
  exclude?: string[];
};

const categorySlugs = new Set(storeCategories.map((category) => category.slug));

export function parseStoreDeviceOptions(params: URLSearchParams): StoreDeviceOptions {
  const limit = Number.parseInt(params.get("limit") ?? "", 10);
  const prefer = params.get("prefer") ?? "";
  const exclude = (params.get("exclude") ?? "")
    .split(",")
    .map((slug) => slug.trim())
    .filter((slug) => categorySlugs.has(slug))
    .slice(0, storeCategories.length);
  return {
    limit: Number.isFinite(limit) ? Math.min(storeDeviceMaxPageSize, Math.max(1, limit)) : storeDevicePageSize,
    ...(categorySlugs.has(prefer) ? { prefer } : {}),
    exclude,
  };
}

function storeDeviceConditions(filters: StoreBrowseFilters, exclude: string[] = []): SQL[] {
  return [
    ...storeBrowseConditions(filters),
    isNotNull(storeScenes.category),
    sql`not (${storeScenes.riskFlags} @> array['shell']::text[])`,
    ...(exclude.length > 0 ? [notInArray(storeScenes.category, exclude)] : []),
  ];
}

// Cut on a code point, never inside a surrogate pair: what the frame shows
// is drawn glyph by glyph.
function clip(text: string | null | undefined, max: number): string {
  const chars = Array.from((text ?? "").replace(/\s+/g, " ").trim());
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : chars.join("");
}

type DeviceRow = {
  category: string | null;
  coverKey: string | null;
  description: string | null;
  hasPreview: boolean;
  id: string;
  latestVersion: number;
  name: string;
  publisher: string | null;
};

function deviceScene(row: DeviceRow, thumb: string | null): StoreDeviceScene {
  return {
    about: clip(row.description, maxAboutLength),
    by: clip(row.publisher, maxByLength),
    category: row.category,
    id: row.id,
    // Versioned, so a frame that keeps covers keeps them by this path.
    image: row.hasPreview ? `/api/store/scenes/${row.id}/image?version=${row.latestVersion}` : null,
    name: clip(row.name, maxNameLength),
    thumb,
    version: row.latestVersion,
  };
}

async function deviceScenes(rows: DeviceRow[]): Promise<StoreDeviceScene[]> {
  const thumbs = await deviceCoverUrls(rows.map((row) => (row.hasPreview ? row.coverKey : null)));
  return rows.map((row, index) => deviceScene(row, thumbs[index] ?? null));
}

const deviceColumns = {
  category: storeScenes.category,
  coverKey: sceneCoverObjectKeySql,
  description: storeScenes.description,
  hasPreview: sceneHasImageSql,
  id: storeScenes.id,
  latestVersion: storeScenes.latestVersion,
  name: storeScenes.name,
  publisher: accounts.displayName,
};

export async function listStoreScenesForDevice(
  db: Database,
  filters: StoreBrowseFilters,
  page: number,
  options: StoreDeviceOptions = {},
): Promise<{ scenes: StoreDeviceScene[]; more: boolean }> {
  const size = options.limit ?? storeDevicePageSize;
  // One row past the page says whether there is another, without a count.
  const rows = await db
    .select(deviceColumns)
    .from(storeScenes)
    .innerJoin(accounts, eq(accounts.id, storeScenes.accountId))
    .where(and(...storeDeviceConditions(filters, options.exclude)))
    .orderBy(
      ...(options.prefer ? [sql`(${storeScenes.category} = ${options.prefer}) desc`] : []),
      sql`${storeScenes.featuredAt} desc nulls last`,
      desc(storeScenes.downloadCount),
      desc(storeScenes.updatedAt),
      storeScenes.id,
    )
    .limit(size + 1)
    .offset((page - 1) * size);
  return {
    more: rows.length > size,
    scenes: await deviceScenes(rows.slice(0, size)),
  };
}

// One scene a frame may be offered, with a short description: what the frame
// shows for an installed store scene, and the version an update would bring.
export async function storeSceneForDevice(
  db: Database,
  sceneId: string,
): Promise<StoreDeviceSceneInfo | null> {
  const [row] = await db
    .select(deviceColumns)
    .from(storeScenes)
    .innerJoin(accounts, eq(accounts.id, storeScenes.accountId))
    .where(and(eq(storeScenes.id, sceneId), ...storeDeviceConditions({ category: "", query: "", tag: "", version: "" })))
    .limit(1);
  if (!row) {
    return null;
  }
  const [scene] = await deviceScenes([row]);
  return { ...scene!, description: clip(row.description, maxDescriptionLength) };
}

// The shelves, in the store front's order, as slug and title alone.
export function storeDeviceCategories(): { slug: string; title: string }[] {
  return storeCategories.map((category) => ({ slug: category.slug, title: category.title }));
}

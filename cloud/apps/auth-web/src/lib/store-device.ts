import { and, arrayOverlaps, desc, eq, isNotNull, not, notInArray, sql, type SQL } from "drizzle-orm";
import { accounts, createDb, storeScenes } from "@frameos-cloud/db";
import { formerCategorySlugs, storeCategories } from "./categories";
import { storeBrowseConditions } from "./store-browse";
import { deviceCoverUrls } from "./store-device-covers";
import { sceneCoverObjectKeySql, sceneHasImageSql } from "./store-listing";
import type { StoreBrowseFilters } from "./store-filters";

// The store as a frame reads it (docs/scene-store.md): the Scene store scene
// on a frame fetches a page of scenes at a time. A frame can be an
// ESP32 parsing this in JavaScript with the whole scene running next to it,
// so the answer is small on purpose: a page the size of the app's grid, short
// keys, a description cut to a line or two, the cover as a path, the icon only
// where a scene has one, and no tags or counts. The browser's
// /api/store/browse is the same query with the card's fields.
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
  // The scene's own icon (docs/scene-icons.md): one SVG path in a 0 0 24 24
  // box, filled with the text color, which the app draws where there is no
  // cover. Left out when the scene has none: a frame parses every byte.
  icon?: string;
  // What it needs of a frame (sceneNeeds.ts: fast, touch, keys, linux), left
  // out when nothing.
  needs?: string[];
};

export type StoreDeviceSceneInfo = StoreDeviceScene & { description: string };

// What a frame asks beyond the store front's filters: how many a page (its
// grid), a shelf to put first, shelves to leave out, what it cannot do
// (`without=fast` on e-paper, `linux` on an ESP32: docs/scene-store.md "What a
// scene needs") and the needs to put first (`prefer=fast` on an LCD,
// `round` on a round panel, `prefer=fast,round` on both, the first said
// weighing most). The app before needs asked `prefer=realtime` /
// `exclude=realtime` of the Real time shelf, which was the fast scenes: both
// still mean that.
export type StoreDeviceOptions = {
  limit?: number;
  prefer?: string;
  preferNeeds?: string[];
  exclude?: string[];
  without?: string[];
};

const categorySlugs = new Set(storeCategories.map((category) => category.slug));
// The needs a frame can say it lacks: touch and keys never rule a scene out.
const ruledOutNeeds = new Set(["fast", "linux", "video"]);
// The needs a frame can put first, by what it says.
const preferredNeeds: Record<string, string> = { fast: "fast", realtime: "fast", round: "round" };

export function parseStoreDeviceOptions(params: URLSearchParams): StoreDeviceOptions {
  const limit = Number.parseInt(params.get("limit") ?? "", 10);
  const preferred = (params.get("prefer") ?? "").split(",").map((part) => part.trim());
  const prefer = preferred.find((part) => categorySlugs.has(part)) ?? "";
  const preferNeeds = [
    ...new Set(preferred.map((part) => preferredNeeds[part]).filter((need): need is string => !!need)),
  ];
  const asked = (params.get("exclude") ?? "").split(",").map((slug) => slug.trim());
  const exclude = asked
    .filter((slug) => categorySlugs.has(slug) && !formerCategorySlugs[slug])
    .slice(0, storeCategories.length);
  const without = new Set(
    (params.get("without") ?? "")
      .split(",")
      .map((need) => need.trim())
      .filter((need) => ruledOutNeeds.has(need)),
  );
  if (asked.includes("realtime")) {
    without.add("fast");
  }
  return {
    limit: Number.isFinite(limit) ? Math.min(storeDeviceMaxPageSize, Math.max(1, limit)) : storeDevicePageSize,
    ...(prefer ? { prefer } : {}),
    ...(preferNeeds.length > 0 ? { preferNeeds } : {}),
    exclude,
    without: [...without],
  };
}

function storeDeviceConditions(
  filters: StoreBrowseFilters,
  exclude: string[] = [],
  without: string[] = [],
): SQL[] {
  return [
    ...storeBrowseConditions(filters),
    isNotNull(storeScenes.category),
    sql`not (${storeScenes.riskFlags} @> array['shell']::text[])`,
    ...(exclude.length > 0 ? [notInArray(storeScenes.category, exclude)] : []),
    ...(without.length > 0 ? [not(arrayOverlaps(storeScenes.needs, without))] : []),
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
  needs: string[];
  coverKey: string | null;
  description: string | null;
  hasPreview: boolean;
  icon: string | null;
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
    ...(row.icon ? { icon: row.icon } : {}),
    ...(row.needs.length > 0 ? { needs: row.needs } : {}),
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
  icon: storeScenes.icon,
  id: storeScenes.id,
  latestVersion: storeScenes.latestVersion,
  name: storeScenes.name,
  needs: storeScenes.needs,
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
    .where(and(...storeDeviceConditions(filters, options.exclude, options.without)))
    .orderBy(
      ...(options.prefer ? [sql`(${storeScenes.category} = ${options.prefer}) desc`] : []),
      ...(options.preferNeeds ?? []).map((need) => sql`(${need} = any(${storeScenes.needs})) desc`),
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

// The shelves, in the store front's order, as slug and title, and `layout:
// true` on a layouts' shelf (the app's Layouts side, docs/scene-store.md).
export function storeDeviceCategories(): { slug: string; title: string; layout?: true }[] {
  return storeCategories.map((category) => ({
    slug: category.slug,
    title: category.title,
    ...(category.kind === "layout" ? { layout: true as const } : {}),
  }));
}

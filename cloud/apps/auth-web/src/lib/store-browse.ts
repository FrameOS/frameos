import { and, desc, eq, gt, ilike, or, sql, type SQL } from "drizzle-orm";
import { accounts, createDb, storeScenes } from "@frameos-cloud/db";
import { storePageSize, type StoreBrowseFilters } from "./store-filters";
import { frameosVersionSatisfiesSql } from "./store-versions-sql";
import { sceneHasAnyImageSql } from "./store-preview";

// One definition of "browse the public store": the SQL that applies the
// filters from store-filters.ts, and the row shape the cards need. The store
// front (app/page) server-renders the first page from here and the lazy feed
// (/api/store/browse) appends the next ones through the very same query, so a
// deep link and an infinite scroll can never disagree.

type Database = ReturnType<typeof createDb>;

export function storeBrowseConditions(filters: StoreBrowseFilters): SQL[] {
  const conditions: SQL[] = [
    eq(storeScenes.visibility, "public"),
    eq(storeScenes.status, "active"),
    gt(storeScenes.latestVersion, 0),
  ];
  if (filters.query) {
    const pattern = `%${filters.query.replace(/[%_\\]/g, "\\$&")}%`;
    const match = or(
      ilike(storeScenes.name, pattern),
      ilike(storeScenes.description, pattern),
      ilike(accounts.displayName, pattern),
      sql`array_to_string(${storeScenes.tags}, ' ') ilike ${pattern}`,
    );
    if (match) {
      conditions.push(match);
    }
  }
  if (filters.tag) {
    conditions.push(sql`${storeScenes.tags} @> array[${filters.tag}]::text[]`);
  }
  if (filters.category) {
    conditions.push(eq(storeScenes.category, filters.category));
  }
  if (filters.version) {
    conditions.push(
      frameosVersionSatisfiesSql(storeScenes.frameosVersion, filters.version),
    );
  }
  return conditions;
}

export type StoreBrowseRow = {
  category: string | null;
  description: string | null;
  downloadCount: number;
  featuredAt: Date | null;
  frameosVersion: string | null;
  hasPreview: boolean;
  id: string;
  name: string;
  publisher: string | null;
  riskFlags: string[];
  slug: string;
  tags: string[];
  updatedAt: Date;
};

// The card payload as it crosses into the browser (Dates become ISO strings).
export type StoreBrowseScene = Omit<
  StoreBrowseRow,
  "featuredAt" | "updatedAt"
> & {
  updatedAt: string;
};

export function serializeStoreScene(row: StoreBrowseRow): StoreBrowseScene {
  const { featuredAt: _featuredAt, updatedAt, ...rest } = row;
  return { ...rest, updatedAt: updatedAt.toISOString() };
}

export async function countStoreScenes(
  db: Database,
  filters: StoreBrowseFilters,
) {
  const [counted] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(storeScenes)
    .innerJoin(accounts, eq(accounts.id, storeScenes.accountId))
    .where(and(...storeBrowseConditions(filters)));
  return counted?.count ?? 0;
}

export async function listStoreScenes(
  db: Database,
  filters: StoreBrowseFilters,
  page: number,
): Promise<StoreBrowseRow[]> {
  return db
    .select({
      category: storeScenes.category,
      description: storeScenes.description,
      downloadCount: storeScenes.downloadCount,
      featuredAt: storeScenes.featuredAt,
      frameosVersion: storeScenes.frameosVersion,
      hasPreview: sceneHasAnyImageSql,
      id: storeScenes.id,
      name: storeScenes.name,
      publisher: accounts.displayName,
      riskFlags: storeScenes.riskFlags,
      slug: storeScenes.slug,
      tags: storeScenes.tags,
      updatedAt: storeScenes.updatedAt,
    })
    .from(storeScenes)
    .innerJoin(accounts, eq(accounts.id, storeScenes.accountId))
    .where(and(...storeBrowseConditions(filters)))
    .orderBy(
      sql`${storeScenes.featuredAt} desc nulls last`,
      desc(storeScenes.downloadCount),
      desc(storeScenes.updatedAt),
    )
    .limit(storePageSize)
    .offset((page - 1) * storePageSize);
}

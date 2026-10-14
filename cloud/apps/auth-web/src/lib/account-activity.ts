import { and, eq, gte, ilike, inArray, lt, ne, or, sql, type SQL } from "drizzle-orm";
import { auditEvents, createDb, frames, storeScenes } from "@frameos-cloud/db";
import { eventLabels } from "./audit-labels";

// The account activity feed's filters (app/account/activity, served by
// /api/account/activity and its histogram): one parser and one WHERE
// builder, so the list and the chart always describe the same slice.

type Db = ReturnType<typeof createDb>;

// Event families for the filter select. Prefix-based, so a new event type
// lands in its family without anyone touching this table; a type whose
// prefix is listed nowhere simply never matches a family filter.
export const activityGroups: Record<string, { label: string; prefixes: string[] }> = {
  account: { label: "Account and sign-in", prefixes: ["account.", "auth.", "admin."] },
  backups: { label: "Backups and backends", prefixes: ["backup.", "backend."] },
  devices: { label: "Linked devices", prefixes: ["device_authorization.", "linked_client."] },
  frames: { label: "Frames", prefixes: ["frame."] },
  photos: { label: "Photos", prefixes: ["photos."] },
  store: { label: "Scene store", prefixes: ["store."] },
};

export interface ActivityFilters {
  from?: Date | undefined;
  group?: string | undefined;
  q?: string | undefined;
  to?: Date | undefined;
}

export const maxActivityQueryLength = 200;

// Reads q / group / from / to off a query string. A malformed date or an
// unknown group is a 400, not a silent "show everything".
export function parseActivityFilters(
  params: URLSearchParams,
): { filters: ActivityFilters } | { error: string } {
  const q = params.get("q")?.trim() ?? "";
  if (q.length > maxActivityQueryLength) {
    return { error: "q is too long" };
  }
  const group = params.get("group")?.trim() ?? "";
  if (group && !activityGroups[group]) {
    return { error: "unknown group" };
  }
  const from = parseDate(params.get("from"));
  const to = parseDate(params.get("to"));
  if (from === null || to === null) {
    return { error: "from and to must be ISO 8601 timestamps" };
  }
  if (from && to && from >= to) {
    return { error: "from must be before to" };
  }
  return {
    filters: {
      ...(from ? { from } : {}),
      ...(group ? { group } : {}),
      ...(q ? { q } : {}),
      ...(to ? { to } : {}),
    },
  };
}

function parseDate(raw: string | null): Date | undefined | null {
  if (!raw) {
    return undefined;
  }
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function likePattern(q: string) {
  return `%${q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

// The WHERE for one account's feed under these filters. Inventory heartbeats
// fire every few minutes and would fill the whole feed, so they are always
// out; the installs page shows the last sync instead.
//
// Search looks where a person's words can land: the event's label (the
// vocabulary lives in audit-labels.ts, so matching labels become an IN list),
// its type, its metadata and target text, the actor's IP, and the names of
// the account's frames and scenes the event is about. The name lookups are
// scoped to the account, so a foreign frame called "kitchen" never widens
// someone else's search.
export async function activityConditions(
  db: Db,
  accountId: string,
  filters: ActivityFilters,
): Promise<SQL[]> {
  const conditions: SQL[] = [
    eq(auditEvents.accountId, accountId),
    ne(auditEvents.eventType, "backend.inventory_synced"),
  ];
  if (filters.from) {
    conditions.push(gte(auditEvents.createdAt, filters.from));
  }
  if (filters.to) {
    conditions.push(lt(auditEvents.createdAt, filters.to));
  }
  if (filters.group) {
    const prefixes = activityGroups[filters.group]?.prefixes ?? [];
    const matches = prefixes.map((prefix) => ilike(auditEvents.eventType, `${prefix}%`));
    conditions.push(or(...matches) ?? sql`false`);
  }
  if (filters.q) {
    const q = filters.q.toLowerCase();
    const pattern = likePattern(filters.q);
    const labelled = Object.entries(eventLabels)
      .filter(([, label]) => label.toLowerCase().includes(q))
      .map(([type]) => type);
    const [frameRows, sceneRows] = await Promise.all([
      db
        .select({ id: frames.id })
        .from(frames)
        .where(and(eq(frames.accountId, accountId), ilike(frames.name, pattern))),
      db
        .select({ id: storeScenes.id })
        .from(storeScenes)
        .where(and(eq(storeScenes.accountId, accountId), ilike(storeScenes.name, pattern))),
    ]);
    const frameTarget = sql`${auditEvents.target}->>'frameId'`;
    const sceneTarget = sql`${auditEvents.target}->>'sceneId'`;
    const clauses: SQL[] = [
      ilike(auditEvents.eventType, pattern),
      sql`${auditEvents.metadata}::text ilike ${pattern}`,
      sql`${auditEvents.target}::text ilike ${pattern}`,
      sql`${auditEvents.actor}->>'ip' ilike ${pattern}`,
    ];
    if (labelled.length > 0) {
      clauses.push(inArray(auditEvents.eventType, labelled));
    }
    if (frameRows.length > 0) {
      clauses.push(inArray(frameTarget, frameRows.map((row) => row.id)));
    }
    if (sceneRows.length > 0) {
      clauses.push(inArray(sceneTarget, sceneRows.map((row) => row.id)));
    }
    conditions.push(or(...clauses) ?? sql`false`);
  }
  return conditions;
}

// The chart's spans and their bucket widths: enough bars to see a shape,
// few enough that each one is still a target to drag across.
export const histogramSpans: Record<string, { seconds: number | null; stepSeconds: number }> = {
  "24h": { seconds: 24 * 3600, stepSeconds: 3600 },
  "7d": { seconds: 7 * 86400, stepSeconds: 6 * 3600 },
  "30d": { seconds: 30 * 86400, stepSeconds: 86400 },
  "90d": { seconds: 90 * 86400, stepSeconds: 86400 },
  all: { seconds: null, stepSeconds: 7 * 86400 },
};

// What every account stores, precomputed for /admin/storage.
//
// The per-account numbers themselves come from usage.ts — the ONE definition
// the quota checks and the account page already share. This module does not
// re-derive them in SQL of its own (that is exactly how the three copies
// usage.ts's header describes drifted); it calls the same functions once per
// account and writes the answers to account_storage_usage, so an admin figure
// and the refusal an account gets can never disagree.
//
// Two buckets are measured only here: retained frame metrics and the cached
// device-asset bytes. Neither counts against any quota, and both are why an
// account can occupy far more disk than its usage page admits.
//
// Refreshing is a background job, never part of rendering: the page reads the
// snapshot and says how old it is, and a stale one triggers a refresh that
// the NEXT load sees (see refreshAccountStorageUsageInBackground).

import { desc, eq, ilike, isNull, or, sql } from "drizzle-orm";
import {
  accountStorageUsage,
  accounts,
  clientBackups,
  frameAssetFiles,
  frameMetrics,
  frames,
} from "@frameos-cloud/db";
import { logError, logInfo } from "./log";
import type { FramesDatabase } from "./frames";
import {
  backupBytesForAccount,
  frameLogBytesForAccount,
  sceneBytesForAccount,
} from "./usage";

/** How old a snapshot may be before a page load kicks off a refresh. */
export const storageSnapshotMaxAgeMs = (() => {
  const raw = process.env.FRAMEOS_CLOUD_STORAGE_SNAPSHOT_MAX_AGE_MINUTES?.trim();
  const parsed = raw ? Number(raw) : Number.NaN;
  const minutes = Number.isFinite(parsed) && parsed > 0 ? parsed : 60;
  return minutes * 60 * 1000;
})();

// How many accounts are measured at once. Each one is six aggregates; all of
// them at once would be a self-inflicted load spike on an instance with a few
// thousand accounts, and one at a time would take minutes.
const refreshConcurrency = 4;

export interface AccountStorageBuckets {
  backupBytes: number;
  backupCount: number;
  frameAssetBytes: number;
  frameLogBytes: number;
  frameMetricsBytes: number;
  privateSceneBytes: number;
  publicSceneBytes: number;
  totalBytes: number;
}

// Retained metrics samples: telemetry the account opted into, kept per the
// deployment's retention and bounded per frame, but never counted anywhere.
async function frameMetricsBytesForAccount(
  db: FramesDatabase,
  accountId: string,
): Promise<number> {
  const [row] = await db
    .select({
      bytes: sql<number>`coalesce(sum(${frameMetrics.sizeBytes}), 0)::float8`,
    })
    .from(frameMetrics)
    .innerJoin(frames, eq(frames.id, frameMetrics.frameId))
    .where(eq(frames.accountId, accountId));
  return Number(row?.bytes ?? 0);
}

// The per-frame asset cache (thumbnails and repeat downloads reassembled from
// the device). An LRU, so it is bounded — but bounded per frame, which means
// an account with fifty frames holds fifty caches.
async function frameAssetBytesForAccount(
  db: FramesDatabase,
  accountId: string,
): Promise<number> {
  const [row] = await db
    .select({
      bytes: sql<number>`coalesce(sum(${frameAssetFiles.sizeBytes}), 0)::float8`,
    })
    .from(frameAssetFiles)
    .innerJoin(frames, eq(frames.id, frameAssetFiles.frameId))
    .where(eq(frames.accountId, accountId));
  return Number(row?.bytes ?? 0);
}

// usage.ts measures backup BYTES (that is what the quota refuses on); the
// admin table also shows how many files those bytes are.
async function backupCountForAccount(
  db: FramesDatabase,
  accountId: string,
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(clientBackups)
    .where(eq(clientBackups.accountId, accountId));
  return Number(row?.count ?? 0);
}

/** Everything one account occupies, measured now. */
export async function measureAccountStorage(
  db: FramesDatabase,
  accountId: string,
): Promise<AccountStorageBuckets> {
  const [scenes, backupBytes, backupCount, frameLogBytes, frameMetricsBytes, frameAssetBytes] =
    await Promise.all([
      sceneBytesForAccount(db, accountId),
      backupBytesForAccount(db, accountId),
      backupCountForAccount(db, accountId),
      frameLogBytesForAccount(db, accountId),
      frameMetricsBytesForAccount(db, accountId),
      frameAssetBytesForAccount(db, accountId),
    ]);
  const buckets = {
    backupBytes,
    backupCount,
    frameAssetBytes,
    frameLogBytes,
    frameMetricsBytes,
    privateSceneBytes: scenes.privateBytes,
    publicSceneBytes: scenes.publicBytes,
  };
  return {
    ...buckets,
    totalBytes:
      buckets.privateSceneBytes +
      buckets.publicSceneBytes +
      buckets.backupBytes +
      buckets.frameLogBytes +
      buckets.frameMetricsBytes +
      buckets.frameAssetBytes,
  };
}

async function writeSnapshot(
  db: FramesDatabase,
  accountId: string,
  buckets: AccountStorageBuckets,
  computedAt: Date,
) {
  const row = {
    accountId,
    backupBytes: Math.round(buckets.backupBytes),
    backupCount: buckets.backupCount,
    computedAt,
    frameAssetBytes: Math.round(buckets.frameAssetBytes),
    frameLogBytes: Math.round(buckets.frameLogBytes),
    frameMetricsBytes: Math.round(buckets.frameMetricsBytes),
    privateSceneBytes: Math.round(buckets.privateSceneBytes),
    publicSceneBytes: Math.round(buckets.publicSceneBytes),
    totalBytes: Math.round(buckets.totalBytes),
  };
  await db
    .insert(accountStorageUsage)
    .values(row)
    .onConflictDoUpdate({ set: row, target: accountStorageUsage.accountId });
}

// One refresh at a time per process, and a second caller waits on the first
// rather than starting a parallel sweep of the same accounts. Next's dev
// server re-evaluates this module on every hot reload, so the flag lives on
// globalThis for the same reason the database pool does.
const flightHolder = globalThis as typeof globalThis & {
  __frameosStorageRefresh?: Promise<StorageRefreshResult> | undefined;
};

export interface StorageRefreshResult {
  accounts: number;
  computedAt: Date;
  durationMs: number;
  failed: number;
}

/**
 * Re-measure every account and rewrite the snapshot. Accounts are measured
 * one batch at a time; a failure on one account is logged and skipped rather
 * than abandoning the sweep, because a single unreadable row must not leave
 * every other figure frozen.
 */
export async function refreshAccountStorageUsage(
  db: FramesDatabase,
): Promise<StorageRefreshResult> {
  const running = flightHolder.__frameosStorageRefresh;
  if (running) {
    return running;
  }
  const flight = runRefresh(db).finally(() => {
    flightHolder.__frameosStorageRefresh = undefined;
  });
  flightHolder.__frameosStorageRefresh = flight;
  return flight;
}

/** True while a refresh is in flight in this process. */
export function storageRefreshInFlight(): boolean {
  return flightHolder.__frameosStorageRefresh !== undefined;
}

async function runRefresh(db: FramesDatabase): Promise<StorageRefreshResult> {
  const startedAt = Date.now();
  const computedAt = new Date();
  const ids = await db.select({ id: accounts.id }).from(accounts);
  let failed = 0;
  for (let index = 0; index < ids.length; index += refreshConcurrency) {
    const batch = ids.slice(index, index + refreshConcurrency);
    await Promise.all(
      batch.map(async ({ id }) => {
        try {
          await writeSnapshot(db, id, await measureAccountStorage(db, id), computedAt);
        } catch (error) {
          failed += 1;
          logError("storage_usage.account_failed", {
            accountId: id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }),
    );
  }
  const result = {
    accounts: ids.length,
    computedAt,
    durationMs: Date.now() - startedAt,
    failed,
  };
  logInfo("storage_usage.refreshed", result);
  return result;
}

/**
 * A refresh that never rejects, for callers that are not waiting on the
 * answer — the admin page hands this to Next's after(), so the sweep runs
 * once the response has already gone out and lands for the next load. A
 * failed background refresh must not take down the page that triggered it,
 * so the error is logged and swallowed here.
 */
export async function refreshAccountStorageUsageSafely(db: FramesDatabase) {
  try {
    await refreshAccountStorageUsage(db);
  } catch (error) {
    logError("storage_usage.refresh_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Just the headline for the admin overview tile: everything measured, and
 * when. One indexed aggregate — cheap enough for a page that renders it
 * alongside seven other counts.
 */
export async function storageSnapshotSummary(db: FramesDatabase): Promise<{
  computedAt: Date | null;
  totalBytes: number;
}> {
  const [row] = await db
    .select({
      computedAt: sql<Date | null>`min(${accountStorageUsage.computedAt})`,
      totalBytes: sql<number>`coalesce(sum(${accountStorageUsage.totalBytes}), 0)::float8`,
    })
    .from(accountStorageUsage);
  return {
    computedAt: row?.computedAt ? new Date(row.computedAt) : null,
    totalBytes: Number(row?.totalBytes ?? 0),
  };
}

export interface AdminStorageRow extends AccountStorageBuckets {
  accountId: string;
  computedAt: Date | null;
  displayName: string | null;
  primaryEmail: string | null;
}

export interface AdminStorageOverview {
  /** Accounts with no snapshot row yet — never measured, or created since. */
  missing: number;
  oldestComputedAt: Date | null;
  rows: AdminStorageRow[];
  totals: AccountStorageBuckets;
}

const zeroBuckets: AccountStorageBuckets = {
  backupBytes: 0,
  backupCount: 0,
  frameAssetBytes: 0,
  frameLogBytes: 0,
  frameMetricsBytes: 0,
  privateSceneBytes: 0,
  publicSceneBytes: 0,
  totalBytes: 0,
};

/**
 * The snapshot as the admin page shows it: biggest first, optionally filtered
 * by email or name. Accounts with no row yet are listed at zero with a null
 * computedAt, so a new account is visibly "not measured yet" rather than
 * silently absent.
 */
export async function listAccountStorageForAdmin(
  db: FramesDatabase,
  query?: string,
  limit = 200,
): Promise<AdminStorageOverview> {
  const trimmed = query?.trim();
  const filter = trimmed
    ? or(
        ilike(accounts.primaryEmail, `%${trimmed}%`),
        ilike(accounts.displayName, `%${trimmed}%`),
      )
    : undefined;

  const rows = await db
    .select({
      accountId: accounts.id,
      backupBytes: accountStorageUsage.backupBytes,
      backupCount: accountStorageUsage.backupCount,
      computedAt: accountStorageUsage.computedAt,
      displayName: accounts.displayName,
      frameAssetBytes: accountStorageUsage.frameAssetBytes,
      frameLogBytes: accountStorageUsage.frameLogBytes,
      frameMetricsBytes: accountStorageUsage.frameMetricsBytes,
      primaryEmail: accounts.primaryEmail,
      privateSceneBytes: accountStorageUsage.privateSceneBytes,
      publicSceneBytes: accountStorageUsage.publicSceneBytes,
      totalBytes: accountStorageUsage.totalBytes,
    })
    .from(accounts)
    .leftJoin(accountStorageUsage, eq(accountStorageUsage.accountId, accounts.id))
    .where(filter)
    .orderBy(desc(sql`coalesce(${accountStorageUsage.totalBytes}, 0)`))
    .limit(limit);

  // The instance totals and the snapshot's age are the whole table's, not
  // this page of it: a search box must not make the fleet look smaller.
  const [summary] = await db
    .select({
      backupBytes: sql<number>`coalesce(sum(${accountStorageUsage.backupBytes}), 0)::float8`,
      backupCount: sql<number>`coalesce(sum(${accountStorageUsage.backupCount}), 0)::int`,
      frameAssetBytes: sql<number>`coalesce(sum(${accountStorageUsage.frameAssetBytes}), 0)::float8`,
      frameLogBytes: sql<number>`coalesce(sum(${accountStorageUsage.frameLogBytes}), 0)::float8`,
      frameMetricsBytes: sql<number>`coalesce(sum(${accountStorageUsage.frameMetricsBytes}), 0)::float8`,
      oldestComputedAt: sql<Date | null>`min(${accountStorageUsage.computedAt})`,
      privateSceneBytes: sql<number>`coalesce(sum(${accountStorageUsage.privateSceneBytes}), 0)::float8`,
      publicSceneBytes: sql<number>`coalesce(sum(${accountStorageUsage.publicSceneBytes}), 0)::float8`,
      totalBytes: sql<number>`coalesce(sum(${accountStorageUsage.totalBytes}), 0)::float8`,
    })
    .from(accountStorageUsage);

  const [missingRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(accounts)
    .leftJoin(accountStorageUsage, eq(accountStorageUsage.accountId, accounts.id))
    .where(isNull(accountStorageUsage.accountId));

  return {
    missing: Number(missingRow?.count ?? 0),
    oldestComputedAt: summary?.oldestComputedAt
      ? new Date(summary.oldestComputedAt)
      : null,
    rows: rows.map((row) => ({
      accountId: row.accountId,
      backupBytes: row.backupBytes ?? 0,
      backupCount: row.backupCount ?? 0,
      computedAt: row.computedAt,
      displayName: row.displayName,
      frameAssetBytes: row.frameAssetBytes ?? 0,
      frameLogBytes: row.frameLogBytes ?? 0,
      frameMetricsBytes: row.frameMetricsBytes ?? 0,
      primaryEmail: row.primaryEmail,
      privateSceneBytes: row.privateSceneBytes ?? 0,
      publicSceneBytes: row.publicSceneBytes ?? 0,
      totalBytes: row.totalBytes ?? 0,
    })),
    totals: summary
      ? {
          backupBytes: Number(summary.backupBytes),
          backupCount: Number(summary.backupCount),
          frameAssetBytes: Number(summary.frameAssetBytes),
          frameLogBytes: Number(summary.frameLogBytes),
          frameMetricsBytes: Number(summary.frameMetricsBytes),
          privateSceneBytes: Number(summary.privateSceneBytes),
          publicSceneBytes: Number(summary.publicSceneBytes),
          totalBytes: Number(summary.totalBytes),
        }
      : zeroBuckets,
  };
}

/** True when the snapshot is old enough (or incomplete enough) to redo. */
export function storageSnapshotIsStale(overview: AdminStorageOverview): boolean {
  if (overview.missing > 0 || !overview.oldestComputedAt) {
    return true;
  }
  return Date.now() - overview.oldestComputedAt.getTime() > storageSnapshotMaxAgeMs;
}

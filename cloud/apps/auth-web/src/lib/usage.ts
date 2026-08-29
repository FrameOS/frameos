// Account storage usage and quotas — the ONE definition both the display
// (/account layout) and the enforcement points (store publish/fork/content,
// gallery images, backups, frame-log culling) share. Before this existed the
// display counted versions + gallery images + preview blobs while enforcement
// counted versions only, and three copies of the query drifted.
//
// Quota philosophy (cloud/docs/cloud-frames.md "Monetization"):
//   * PUBLIC store scenes are free — publishing for everyone costs the
//     account nothing; only private scenes count against the scene quota.
//   * Frame logs are telemetry: over budget the OLDEST lines are culled,
//     never refused (a frame must not learn its logs bounced).
//   * Scenes and backups are user data: over budget new writes are refused
//     with a clear error, never deleted.
// Defaults are deliberately generous; paid tiers can raise them later (the
// limits ride along in every usage payload so UIs never hardcode them).

import { and, eq, gt, or, sql } from "drizzle-orm";
import {
  clientBackups,
  frameLogs,
  frames,
  storeImages,
  storeSceneVersionImages,
  storeScenes,
  storeSceneVersions,
} from "@frameos-cloud/db";
import { logWarn } from "./log";
import type { FramesDatabase } from "./frames";

// THE free tier. These three plus maxFramesPerAccount (frames.ts) are every
// number an account is measured against, and each is overridable per
// deployment so a paid tier is a config change rather than a code change —
// the limits also ride along in every usage payload, so no UI hardcodes them.
//
// Numbers unchanged from when they were plain constants: they were chosen to
// be generous enough that no hobbyist meets them, and naming them "the free
// tier" must not be the thing that takes storage away from anyone.
function megabyteLimitFromEnv(name: string, fallbackMb: number): number {
  const raw = process.env[name]?.trim();
  const parsed = raw ? Number(raw) : Number.NaN;
  if (raw && (!Number.isFinite(parsed) || parsed <= 0)) {
    // A typo'd limit must not fail the boot, and must not silently run either.
    logWarn("usage.invalid_limit_env", { fallbackMb, name, value: raw });
  }
  const mb = Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackMb;
  return Math.round(mb * 1024 * 1024);
}

// How many frames an account may hold. Lives here rather than in frames.ts
// so the whole free tier is one block; frames.ts re-exports it, because
// usage.ts may only TYPE-import from frames.ts (frames.ts imports this module
// at runtime, and a cycle in the other direction would bite at module load).
export const maxFramesPerAccount = (() => {
  const raw = process.env.FRAMEOS_CLOUD_MAX_FRAMES_PER_ACCOUNT?.trim();
  const parsed = raw ? Number(raw) : Number.NaN;
  if (raw && (!Number.isInteger(parsed) || parsed < 1)) {
    logWarn("usage.invalid_limit_env", {
      fallback: 50,
      name: "FRAMEOS_CLOUD_MAX_FRAMES_PER_ACCOUNT",
      value: raw,
    });
  }
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : 50;
})();

export const maxPrivateSceneBytesPerAccount = megabyteLimitFromEnv(
  "FRAMEOS_CLOUD_MAX_PRIVATE_SCENE_MB",
  100,
);
export const maxBackupBytesPerAccount = megabyteLimitFromEnv(
  "FRAMEOS_CLOUD_MAX_BACKUP_MB",
  100,
);
export const maxFrameLogBytesPerAccount = megabyteLimitFromEnv(
  "FRAMEOS_CLOUD_MAX_FRAME_LOG_MB",
  100,
);

export interface SceneBytesBreakdown {
  privateBytes: number;
  publicBytes: number;
}

// Scene bytes are counted per distinct object, not per row: versions and
// images are content-addressed, so a screenshot kept across ten versions or
// shared by a fork is stored once and billed once. Public scenes are free;
// an object is metered when any private scene of the account uses it.
const distinctVersionBytes = sql`
  select v.sha256, max(v.size_bytes) as size_bytes,
         bool_or(s.visibility <> 'public') as metered
    from ${storeSceneVersions} v
    join ${storeScenes} s on s.id = v.scene_id
   where s.account_id = `;
const distinctImageBytes = sql`
  select i.sha256, max(i.size_bytes) as size_bytes,
         bool_or(s.visibility <> 'public') as metered
    from ${storeImages} i
    join ${storeSceneVersionImages} vi on vi.image_sha256 = i.sha256
    join ${storeSceneVersions} v on v.id = vi.version_id
    join ${storeScenes} s on s.id = v.scene_id
   where s.account_id = `;

async function splitBytes(
  db: FramesDatabase,
  accountId: string,
  distinct: ReturnType<typeof sql>,
): Promise<SceneBytesBreakdown> {
  const [row] = await db.execute<{ private_bytes: number; public_bytes: number }>(
    sql`select coalesce(sum(case when metered then size_bytes else 0 end), 0)::float8 as private_bytes,
               coalesce(sum(case when metered then 0 else size_bytes end), 0)::float8 as public_bytes
          from (${distinct}${accountId} group by 1) as objects`,
  );
  return {
    privateBytes: Number(row?.private_bytes ?? 0),
    publicBytes: Number(row?.public_bytes ?? 0),
  };
}

// A scene's bytes = its versions + the images its versions link.
export async function sceneBytesForAccount(
  db: FramesDatabase,
  accountId: string,
): Promise<SceneBytesBreakdown> {
  const [versions, images] = await Promise.all([
    splitBytes(db, accountId, distinctVersionBytes),
    splitBytes(db, accountId, distinctImageBytes),
  ]);
  return {
    privateBytes: versions.privateBytes + images.privateBytes,
    publicBytes: versions.publicBytes + images.publicBytes,
  };
}

/** The metered scene bytes only: everything except public scenes. */
export async function privateSceneBytesForAccount(
  db: FramesDatabase,
  accountId: string,
): Promise<number> {
  return (await sceneBytesForAccount(db, accountId)).privateBytes;
}

/** One scene's total bytes (distinct versions + distinct linked images). */
export async function sceneBytesTotal(
  db: FramesDatabase,
  sceneId: string,
): Promise<number> {
  const [row] = await db.execute<{ bytes: number }>(
    sql`select (
      (select coalesce(sum(size_bytes), 0) from (
         select max(size_bytes) as size_bytes from ${storeSceneVersions}
          where scene_id = ${sceneId} group by sha256) as versions)
      +
      (select coalesce(sum(size_bytes), 0) from (
         select max(i.size_bytes) as size_bytes
           from ${storeImages} i
           join ${storeSceneVersionImages} vi on vi.image_sha256 = i.sha256
           join ${storeSceneVersions} v on v.id = vi.version_id
          where v.scene_id = ${sceneId} group by i.sha256) as images)
    )::float8 as bytes`,
  );
  return Number(row?.bytes ?? 0);
}

export async function backupBytesForAccount(
  db: FramesDatabase,
  accountId: string,
): Promise<number> {
  const [row] = await db
    .select({
      bytes: sql<number>`coalesce(sum(${clientBackups.sizeBytes}), 0)::float8`,
    })
    .from(clientBackups)
    .where(eq(clientBackups.accountId, accountId));
  return Number(row?.bytes ?? 0);
}

// Frames revoked within this window still count toward the account quota.
// Without it the quota is freely cycleable (revoke → enroll → revoke → …)
// and the dead rows — with their command queues and retained logs — pile up
// unboundedly. Actually deleting them belongs in db-cleanup.sh, which today
// prunes logs by age but never dead frame rows.
export const revokedFrameQuotaGraceMs = 24 * 60 * 60 * 1000;

/** Frames counting against the quota — the number enrollment refuses on, and
 *  therefore the only number the account page may display. */
export async function countFramesForAccount(
  db: FramesDatabase,
  accountId: string,
): Promise<number> {
  const graceCutoff = new Date(Date.now() - revokedFrameQuotaGraceMs);
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(frames)
    .where(
      and(
        eq(frames.accountId, accountId),
        or(sql`${frames.status} <> 'revoked'`, gt(frames.updatedAt, graceCutoff)),
      ),
    );
  return row?.count ?? 0;
}

export async function frameLogBytesForAccount(
  db: FramesDatabase,
  accountId: string,
): Promise<number> {
  const [row] = await db
    .select({
      bytes: sql<number>`coalesce(sum(${frameLogs.sizeBytes}), 0)::float8`,
    })
    .from(frameLogs)
    .innerJoin(frames, eq(frames.id, frameLogs.frameId))
    .where(eq(frames.accountId, accountId));
  return Number(row?.bytes ?? 0);
}

/**
 * The account's full usage snapshot, in the wire shape shared by the cloud
 * UI, GET /api/backends/grants (linked backends cache and display it) and —
 * later — paid tiers. snake_case: it crosses the AGPL boundary to
 * third-party reimplementations.
 */
export async function accountUsage(db: FramesDatabase, accountId: string) {
  const [scenes, backups, logs, frameCount] = await Promise.all([
    sceneBytesForAccount(db, accountId),
    backupBytesForAccount(db, accountId),
    frameLogBytesForAccount(db, accountId),
    countFramesForAccount(db, accountId),
  ]);
  return {
    backups: {
      bytes: Math.round(backups),
      max_bytes: maxBackupBytesPerAccount,
    },
    // Not bytes, but the same shape of promise to the account: here is the
    // limit, here is where you are against it. Revoked frames still hold a
    // row and still count — same rule the enrollment quota enforces, so the
    // display cannot disagree with the refusal.
    frames: {
      count: frameCount,
      max_count: maxFramesPerAccount,
    },
    frame_logs: {
      bytes: Math.round(logs),
      max_bytes: maxFrameLogBytesPerAccount,
    },
    scenes: {
      private_bytes: Math.round(scenes.privateBytes),
      private_max_bytes: maxPrivateSceneBytesPerAccount,
      // Public scenes are free; reported so UIs can say so instead of
      // summing everything into one misleading number.
      public_bytes: Math.round(scenes.publicBytes),
    },
  };
}

export type AccountUsage = Awaited<ReturnType<typeof accountUsage>>;

/**
 * Cull the OLDEST frame-log rows across the whole account until the total is
 * back under budget. Runs inside the log-ingestion transaction; the running
 * sum walks newest→oldest, so everything past the budget line (the oldest
 * lines) goes in one statement. Cheap when under budget: callers gate on the
 * SUM above first.
 */
export async function cullFrameLogsOverBudget(
  db: FramesDatabase,
  accountId: string,
): Promise<void> {
  await db.execute(sql`
    with ordered as (
      select fl.id,
             sum(fl.size_bytes) over (order by fl.id desc) as running
      from ${frameLogs} fl
      join ${frames} f on f.id = fl.frame_id
      where f.account_id = ${accountId}
    )
    delete from ${frameLogs}
    where id in (
      select id from ordered where running > ${maxFrameLogBytesPerAccount}
    )
  `);
}

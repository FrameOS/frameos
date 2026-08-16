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
  storeSceneImages,
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

// Blob sizes now come from a column, because the bytes themselves have moved
// to object storage and octet_length() has nothing left to measure. Rows
// written before migration 0032 still hold their bytes in Postgres, so the
// column falls back to measuring them — one expression, both eras.
const sceneImageBytes = sql`coalesce(${storeSceneImages.sizeBytes}, octet_length(${storeSceneImages.content}), 0)`;
const scenePreviewBytes = sql`coalesce(${storeScenes.previewImageSizeBytes}, octet_length(${storeScenes.previewImage}), 0)`;

const publicCase = (bytes: ReturnType<typeof sql>) =>
  sql<number>`coalesce(sum(case when ${storeScenes.visibility} = 'public' then ${bytes} else 0 end), 0)::float8`;
const privateCase = (bytes: ReturnType<typeof sql>) =>
  sql<number>`coalesce(sum(case when ${storeScenes.visibility} <> 'public' then ${bytes} else 0 end), 0)::float8`;

// A scene's bytes = its versions + gallery images + the primary preview
// blob. Three flat join-aggregates (versions × images would cross-multiply
// in a single join), each split by visibility so private (metered) and
// public (free) stay apart.
export async function sceneBytesForAccount(
  db: FramesDatabase,
  accountId: string,
): Promise<SceneBytesBreakdown> {
  const [[versions], [images], [previews]] = await Promise.all([
    db
      .select({
        privateBytes: privateCase(sql`${storeSceneVersions.sizeBytes}`),
        publicBytes: publicCase(sql`${storeSceneVersions.sizeBytes}`),
      })
      .from(storeSceneVersions)
      .innerJoin(storeScenes, eq(storeScenes.id, storeSceneVersions.sceneId))
      .where(eq(storeScenes.accountId, accountId)),
    db
      .select({
        privateBytes: privateCase(sceneImageBytes),
        publicBytes: publicCase(sceneImageBytes),
      })
      .from(storeSceneImages)
      .innerJoin(storeScenes, eq(storeScenes.id, storeSceneImages.sceneId))
      .where(eq(storeScenes.accountId, accountId)),
    db
      .select({
        privateBytes: privateCase(scenePreviewBytes),
        publicBytes: publicCase(scenePreviewBytes),
      })
      .from(storeScenes)
      .where(eq(storeScenes.accountId, accountId)),
  ]);
  return {
    privateBytes:
      Number(versions?.privateBytes ?? 0) +
      Number(images?.privateBytes ?? 0) +
      Number(previews?.privateBytes ?? 0),
    publicBytes:
      Number(versions?.publicBytes ?? 0) +
      Number(images?.publicBytes ?? 0) +
      Number(previews?.publicBytes ?? 0),
  };
}

/** The metered scene bytes only: everything except public scenes. */
export async function privateSceneBytesForAccount(
  db: FramesDatabase,
  accountId: string,
): Promise<number> {
  return (await sceneBytesForAccount(db, accountId)).privateBytes;
}

/** One scene's total bytes (versions + gallery images + preview blob). */
export async function sceneBytesTotal(
  db: FramesDatabase,
  sceneId: string,
): Promise<number> {
  const [[versions], [images], [preview]] = await Promise.all([
    db
      .select({
        bytes: sql<number>`coalesce(sum(${storeSceneVersions.sizeBytes}), 0)::float8`,
      })
      .from(storeSceneVersions)
      .where(eq(storeSceneVersions.sceneId, sceneId)),
    db
      .select({
        bytes: sql<number>`coalesce(sum(${sceneImageBytes}), 0)::float8`,
      })
      .from(storeSceneImages)
      .where(eq(storeSceneImages.sceneId, sceneId)),
    db
      .select({
        bytes: sql<number>`coalesce(${scenePreviewBytes}, 0)::float8`,
      })
      .from(storeScenes)
      .where(eq(storeScenes.id, sceneId)),
  ]);
  return (
    Number(versions?.bytes ?? 0) +
    Number(images?.bytes ?? 0) +
    Number(preview?.bytes ?? 0)
  );
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

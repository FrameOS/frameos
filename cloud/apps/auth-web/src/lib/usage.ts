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
  accountAiUsage,
  accountMarginBasisPoints,
  readAccountPlan,
  readBillingSettings,
  utcDayWindow,
  utcMonthWindow,
  type AccountPlan,
} from "@frameos-cloud/ledger";
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

// Boards below the capability line — no PSRAM, so no on-device renderer:
// ESP32-C3 and the Pico family (embedded_firmware.py: localRenderSupported
// false). Serving one means the control plane renders every frame for it,
// which is the paid entitlement of cloud/docs/accounting-todo.md §0.2 —
// `cloud_rendered_frames` on the plan, zero on the free tier — enforced as N
// frames AND a minimum refresh interval, because renders per day is the cost.
// The SQL in countCloudRenderedFramesForAccount mirrors this list; keep both
// in step.
export const cloudRenderedPlatformPrefixes = ["esp32-c3", "pico"] as const;

export function hardwareIsCloudRendered(hardware: unknown): boolean {
  if (!hardware || typeof hardware !== "object") {
    return false;
  }
  const record = hardware as { localRenderSupported?: unknown; platform?: unknown };
  if (record.localRenderSupported === false) {
    return true;
  }
  const platform = typeof record.platform === "string" ? record.platform.toLowerCase() : "";
  return cloudRenderedPlatformPrefixes.some((prefix) => platform.startsWith(prefix));
}

// The refresh-interval floor for a cloud-rendered frame (§0.2: proposal 5
// minutes). Displayed nowhere as a headline number — the plan sells "N
// frames" — but enforced on every settings push to such a frame.
export const cloudRenderedMinIntervalSeconds = (() => {
  const raw = process.env.FRAMEOS_CLOUD_RENDERED_MIN_INTERVAL_SECONDS?.trim();
  const parsed = raw ? Number(raw) : Number.NaN;
  if (raw && (!Number.isInteger(parsed) || parsed < 1)) {
    logWarn("usage.invalid_limit_env", {
      fallback: 300,
      name: "FRAMEOS_CLOUD_RENDERED_MIN_INTERVAL_SECONDS",
      value: raw,
    });
  }
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : 300;
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

/**
 * The quota numbers that apply to ONE account: its plan's entitlements
 * (cloud/docs/accounting-todo.md §0.1), falling back to the free-tier
 * constants above for a deployment with no plans seeded.
 *
 * Every enforcement point takes its limit from here rather than from the
 * constants, because a display that promises 10 GB while the refusal fires
 * at 100 MB is worse than having no plans at all. The constants stay
 * exported as the free tier and the fallback — the numbers migration 0045
 * seeds for `payg` are deliberately identical to them, so nothing an
 * existing account has today gets smaller the day plans land.
 */
export interface AccountLimits {
  backupBytes: number;
  // Frames the cloud renders because there is no computer at the other end
  // (§0.2). Zero on the free plan: it is the one entitlement with a real
  // marginal cost.
  cloudRenderedFrames: number;
  frameLogBytes: number;
  frames: number;
  plan: {
    code: string;
    marginBasisPoints: number;
    name: string;
    priceMicros: bigint;
  };
  privateSceneBytes: number;
  subscribed: boolean;
}

export const freeTierLimits: Omit<AccountLimits, "plan" | "subscribed"> = {
  backupBytes: maxBackupBytesPerAccount,
  cloudRenderedFrames: 0,
  frameLogBytes: maxFrameLogBytesPerAccount,
  frames: maxFramesPerAccount,
  privateSceneBytes: maxPrivateSceneBytesPerAccount,
};

export async function accountLimits(
  db: FramesDatabase,
  accountId: string,
  // The caller's already-read plan, when it has one. accountUsage() reads it
  // once and hands it to both consumers rather than paying for the same
  // lookup twice on a page that renders one account.
  known?: AccountPlan | undefined,
): Promise<AccountLimits> {
  let accountPlan: AccountPlan | undefined = known;
  try {
    accountPlan ??= await readAccountPlan(db, accountId);
  } catch {
    // A deployment whose plan tables have not been migrated yet must keep
    // enforcing the free tier rather than failing every quota check. The
    // fallback is the same numbers, so nothing changes for anyone.
    accountPlan = undefined;
  }
  if (!accountPlan) {
    return {
      ...freeTierLimits,
      plan: {
        code: "payg",
        marginBasisPoints: 10_000,
        name: "Pay as you go",
        priceMicros: 0n,
      },
      subscribed: false,
    };
  }
  const { entitlements } = accountPlan.plan;
  return {
    // The larger of the plan and the deployment's configured floor: an
    // operator who raised FRAMEOS_CLOUD_MAX_BACKUP_MB for everybody must not
    // have it silently lowered by a plan row.
    backupBytes: Math.max(entitlements.backupBytes, maxBackupBytesPerAccount),
    cloudRenderedFrames: entitlements.cloudRenderedFrames,
    frameLogBytes: Math.max(entitlements.frameLogBytes, maxFrameLogBytesPerAccount),
    frames: Math.max(entitlements.frames, maxFramesPerAccount),
    plan: {
      code: accountPlan.plan.code,
      marginBasisPoints: accountPlan.plan.marginBasisPoints,
      name: accountPlan.plan.name,
      priceMicros: accountPlan.plan.priceMicros,
    },
    privateSceneBytes: Math.max(
      entitlements.privateSceneBytes,
      maxPrivateSceneBytesPerAccount,
    ),
    subscribed: accountPlan.subscribed,
  };
}

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

/** Frames the cloud renders for (hardwareIsCloudRendered), counted with the
 *  same revoked-grace rule as countFramesForAccount so the display and the
 *  refusal agree. */
export async function countCloudRenderedFramesForAccount(
  db: FramesDatabase,
  accountId: string,
): Promise<number> {
  const graceCutoff = new Date(Date.now() - revokedFrameQuotaGraceMs);
  const platform = sql`lower(coalesce(${frames.hardware} ->> 'platform', ''))`;
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(frames)
    .where(
      and(
        eq(frames.accountId, accountId),
        or(sql`${frames.status} <> 'revoked'`, gt(frames.updatedAt, graceCutoff)),
        or(
          sql`${frames.hardware} ->> 'localRenderSupported' = 'false'`,
          ...cloudRenderedPlatformPrefixes.map((prefix) => sql`${platform} like ${prefix + "%"}`),
        ),
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
  const now = new Date();
  // One plan lookup for both the quota limits and the AI summary; `undefined`
  // when the accounting tables are not migrated, which both handle.
  const plan = await readAccountPlan(db, accountId).catch(() => undefined);
  const [scenes, backups, logs, frameCount, cloudRenderedCount, limits, ai] = await Promise.all([
    sceneBytesForAccount(db, accountId),
    backupBytesForAccount(db, accountId),
    frameLogBytesForAccount(db, accountId),
    countFramesForAccount(db, accountId),
    countCloudRenderedFramesForAccount(db, accountId),
    accountLimits(db, accountId, plan),
    accountAiSummary(db, accountId, now, plan),
  ]);
  return {
    ai,
    backups: {
      bytes: Math.round(backups),
      max_bytes: limits.backupBytes,
    },
    // Not bytes, but the same shape of promise to the account: here is the
    // limit, here is where you are against it. Revoked frames still hold a
    // row and still count — same rule the enrollment quota enforces, so the
    // display cannot disagree with the refusal.
    frames: {
      count: frameCount,
      max_count: limits.frames,
    },
    // §0.2: boards the cloud renders for. A separate pool from `frames` — a
    // self-hosted Pi costs a WebSocket and a row, a thin client costs a
    // render per refresh.
    cloud_rendered_frames: {
      count: cloudRenderedCount,
      max_count: limits.cloudRenderedFrames,
      min_interval_seconds: cloudRenderedMinIntervalSeconds,
    },
    frame_logs: {
      bytes: Math.round(logs),
      max_bytes: limits.frameLogBytes,
    },
    // Which plan these limits came from, so a UI can say "on the Maker plan"
    // beside the numbers rather than presenting them as laws of nature.
    plan: {
      code: limits.plan.code,
      // Basis points, and a string price: the payload crosses the AGPL
      // boundary to third-party reimplementations, and a micro-dollar amount
      // is a bigint that JSON's single number type would quietly round.
      margin_basis_points: limits.plan.marginBasisPoints,
      name: limits.plan.name,
      price_micros: limits.plan.priceMicros.toString(),
      subscribed: limits.subscribed,
    },
    scenes: {
      private_bytes: Math.round(scenes.privateBytes),
      private_max_bytes: limits.privateSceneBytes,
      // Public scenes are free; reported so UIs can say so instead of
      // summing everything into one misleading number.
      public_bytes: Math.round(scenes.publicBytes),
    },
  };
}

export type AccountUsage = Awaited<ReturnType<typeof accountUsage>>;

/**
 * AI spend in the same "here is the limit, here is where you are against it"
 * shape as every storage bucket (cloud/docs/accounting-todo.md §5.2).
 *
 * `month_micros` is what this month WOULD be billed at, not what has been
 * charged: while `metering_mode` is "shadow" nothing is charged at all, and
 * `price_micros` is zero on every row — a figure built on it would tell
 * every user they had used nothing. Any UI must read `metering_mode` before
 * putting a currency symbol in front of this and calling it a bill.
 *
 * Degrades to a disabled-looking zero rather than throwing: a deployment
 * whose accounting tables have not been migrated must still render an
 * account page.
 */
async function accountAiSummary(
  db: FramesDatabase,
  accountId: string,
  now: Date,
  known?: AccountPlan | undefined,
) {
  try {
    const [thisMonth, lastMonth, today, settings] = await Promise.all([
      accountAiUsage(db, accountId, utcMonthWindow(now)),
      accountAiUsage(db, accountId, utcMonthWindow(now, -1)),
      accountAiUsage(db, accountId, utcDayWindow(now)),
      readBillingSettings(db),
    ]);
    const [account] = await db.execute<{ ai_disabled_at: string | null }>(
      sql`select ai_disabled_at from accounts where id = ${accountId}`,
    );
    return {
      // What they actually owe, which is narrower than what they used: only
      // the platform key bills anybody (see billing() in metering.ts).
      billable_micros: thisMonth.billableMicros.toString(),
      daily_cap_micros: settings.dailyCapMicros.toString(),
      enabled: !account?.ai_disabled_at,
      // The same function metering prices with — one definition (plans.ts).
      // `known` is the caller's already-read plan; the margin lookup reads it
      // again only when nobody handed one in.
      margin_basis_points: known?.plan.fromTable
        ? known.plan.marginBasisPoints
        : await accountMarginBasisPoints(db, accountId, settings),
      metering_mode: settings.meteringMode as string,
      month_micros: thisMonth.chargeableMicros.toString(),
      own_key_only: thisMonth.ownKeyOnly,
      previous_month_micros: lastMonth.chargeableMicros.toString(),
      today_micros: today.chargeableMicros.toString(),
      turns_this_month: thisMonth.turns,
    };
  } catch {
    return {
      billable_micros: "0",
      daily_cap_micros: "0",
      enabled: true,
      margin_basis_points: 0,
      metering_mode: "shadow" as string,
      month_micros: "0",
      own_key_only: false,
      previous_month_micros: "0",
      today_micros: "0",
      turns_this_month: 0,
    };
  }
}

/**
 * Cull the OLDEST frame-log rows across the whole account until the total is
 * back under budget. Runs inside the log-ingestion transaction; the running
 * sum walks newest→oldest, so everything past the budget line (the oldest
 * lines) goes in one statement. Cheap when under budget: callers gate on the
 * SUM above first.
 */
// The chatty frame pays first: its own oldest lines go until the account is
// back under budget (or the frame has nothing older than the lines it just
// shipped). Only when that is not enough does the account-wide cull run —
// otherwise one frame in a boot loop (or an unconfirmed frame from a leaked
// image, before the hub started dropping those) would erase the quiet
// frames' whole history to make room for its noise. Returns true when the
// account is still over budget afterwards.
export async function cullFrameLogsForFrameOverBudget(
  db: FramesDatabase,
  accountId: string,
  frameId: string,
): Promise<boolean> {
  const { frameLogBytes } = await accountLimits(db, accountId);
  const [totals] = await db
    .select({
      account: sql<number>`coalesce(sum(${frameLogs.sizeBytes}), 0)::float8`,
      frame: sql<number>`coalesce(sum(${frameLogs.sizeBytes}) filter (where ${frameLogs.frameId} = ${frameId}), 0)::float8`,
    })
    .from(frameLogs)
    .innerJoin(frames, eq(frames.id, frameLogs.frameId))
    .where(eq(frames.accountId, accountId));
  const accountBytes = Number(totals?.account ?? 0);
  const frameBytes = Number(totals?.frame ?? 0);
  if (accountBytes <= frameLogBytes) {
    return false;
  }
  const allowance = Math.max(0, frameLogBytes - (accountBytes - frameBytes));
  await db.execute(sql`
    with ordered as (
      select fl.id,
             sum(fl.size_bytes) over (order by fl.id desc) as running
      from ${frameLogs} fl
      where fl.frame_id = ${frameId}
    )
    delete from ${frameLogs}
    where id in (
      select id from ordered where running > ${allowance}
    )
  `);
  return accountBytes - Math.max(0, frameBytes - allowance) > frameLogBytes;
}

export async function cullFrameLogsOverBudget(
  db: FramesDatabase,
  accountId: string,
): Promise<void> {
  const { frameLogBytes } = await accountLimits(db, accountId);
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
      select id from ordered where running > ${frameLogBytes}
    )
  `);
}

import { asc, eq } from "drizzle-orm";
import { billingPlans, subscriptions } from "@frameos-cloud/db";
import { readBillingSettings, type BillingSettings } from "./settings";
import type { LedgerExecutor } from "./types";

// Plans (§0.1) and what an account's plan means for the rest of the system.
//
// The ladder varies ONE thing that costs money — the margin on metered AI —
// and a handful of quotas that do not. That is the whole design: a plan is a
// better rate on something everybody may already use, never a wall in front
// of a feature. Nothing here is an accounting fact; the ledger sees only the
// entries `rules/subscription.ts` posts, and `rules/ai-usage.ts` never learns
// that plans exist at all (§3.6).
//
// PAYG is a real plan row at $0 rather than the absence of one, so "what plan
// is this account on" always has an answer. An account with no subscription
// row is on PAYG anyway — the fallback below — because enrolling every
// existing account must not be a prerequisite for shipping this.

export const paygPlanCode = "payg";

export interface PlanEntitlements {
  backupBytes: number;
  // The one entitlement with a real marginal cost (§0.2): frames the cloud
  // renders because there is no computer at the other end. Free plans get
  // none, which is what unblocks thin clients in the cloud flasher.
  cloudRenderedFrames: number;
  frameLogBytes: number;
  frames: number;
  privateSceneBytes: number;
}

export interface BillingPlan {
  code: string;
  currency: string;
  description: string | null;
  entitlements: PlanEntitlements;
  // False when this is the code-level fallback rather than a billing_plans
  // row — the one case in which the deployment's global margin setting is
  // still the margin (see accountMarginBasisPoints).
  fromTable: boolean;
  marginBasisPoints: number;
  name: string;
  period: string;
  priceMicros: bigint;
  public: boolean;
  sortOrder: number;
}

export interface AccountPlan {
  // Set when the account cancelled: the plan runs to here and then stops.
  cancelAt: Date | null;
  // Set when the account downgraded: `plan` runs to the end of the current
  // period and this one takes over at the rollover.
  nextPlanCode: string | null;
  plan: BillingPlan;
  // False when the account has no subscription row and is on the PAYG
  // fallback — the page says "Pay as you go" either way, but "did somebody
  // choose this" is a different question from "what applies".
  subscribed: boolean;
  status: string;
}

// The code-level fallback for a database whose plans have never been seeded,
// and the shape every entitlement lookup degrades to. Same numbers migration
// 0045 seeds; free-tier quotas match src/lib/usage.ts's historical defaults,
// because naming something "the free plan" must not be the thing that takes
// storage away from anybody who already had it.
export const fallbackPaygPlan: BillingPlan = {
  code: paygPlanCode,
  currency: "USD",
  description: "AI when you want it, billed monthly for exactly what you used.",
  entitlements: {
    backupBytes: 100 * 1024 * 1024,
    cloudRenderedFrames: 0,
    frameLogBytes: 100 * 1024 * 1024,
    frames: 50,
    privateSceneBytes: 100 * 1024 * 1024,
  },
  fromTable: false,
  marginBasisPoints: 10_000,
  name: "Pay as you go",
  period: "month",
  priceMicros: 0n,
  public: true,
  sortOrder: 0,
};

type PlanRow = typeof billingPlans.$inferSelect;

function entitlementsFrom(value: unknown): PlanEntitlements {
  const raw =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  // A missing entitlement falls back to the free plan's rather than to zero:
  // a plan row written by hand with one key in it must not silently revoke
  // everything else.
  const number = (key: string, fallback: number): number => {
    const candidate = raw[key];
    return typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0
      ? Math.round(candidate)
      : fallback;
  };
  const base = fallbackPaygPlan.entitlements;
  return {
    backupBytes: number("backup_bytes", base.backupBytes),
    cloudRenderedFrames: number("cloud_rendered_frames", base.cloudRenderedFrames),
    frameLogBytes: number("frame_log_bytes", base.frameLogBytes),
    frames: number("frames", base.frames),
    privateSceneBytes: number("private_scene_bytes", base.privateSceneBytes),
  };
}

function toPlan(row: PlanRow): BillingPlan {
  return {
    code: row.code,
    currency: row.currency,
    description: row.description,
    entitlements: entitlementsFrom(row.entitlements),
    fromTable: true,
    marginBasisPoints: row.marginBasisPoints,
    name: row.name,
    period: row.period,
    priceMicros: row.priceMicros,
    public: row.public,
    sortOrder: row.sortOrder,
  };
}

/** Every plan, cheapest first. `public: false` rows are for grandfathered or
 *  negotiated arrangements and are excluded from the plans page. */
export async function listPlans(db: LedgerExecutor): Promise<BillingPlan[]> {
  const rows = await db
    .select()
    .from(billingPlans)
    .orderBy(asc(billingPlans.sortOrder), asc(billingPlans.priceMicros));
  return rows.length > 0 ? rows.map(toPlan) : [fallbackPaygPlan];
}

export async function readPlan(
  db: LedgerExecutor,
  code: string,
): Promise<BillingPlan | undefined> {
  const [row] = await db
    .select()
    .from(billingPlans)
    .where(eq(billingPlans.code, code))
    .limit(1);
  if (row) {
    return toPlan(row);
  }
  return code === paygPlanCode ? fallbackPaygPlan : undefined;
}

/** The plan an account is actually on right now, with the PAYG fallback. */
export async function readAccountPlan(
  db: LedgerExecutor,
  accountId: string,
): Promise<AccountPlan> {
  const [row] = await db
    .select({
      cancelAt: subscriptions.cancelAt,
      nextPlanCode: subscriptions.nextPlanCode,
      plan: billingPlans,
      status: subscriptions.status,
    })
    .from(subscriptions)
    .innerJoin(billingPlans, eq(billingPlans.code, subscriptions.planCode))
    .where(eq(subscriptions.accountId, accountId))
    .limit(1);

  // A cancelled subscription is not a plan any more, and neither is one whose
  // cancel_at has passed without the nightly job having tidied it up yet: the
  // entitlement has to expire on time even if the job is late, or a downgrade
  // is silently free for however long the job is broken.
  const expired =
    !row ||
    row.status === "canceled" ||
    (row.cancelAt !== null && row.cancelAt.getTime() <= Date.now());
  if (expired) {
    return {
      cancelAt: null,
      nextPlanCode: null,
      plan: (await readPlan(db, paygPlanCode)) ?? fallbackPaygPlan,
      status: "active",
      subscribed: false,
    };
  }
  return {
    cancelAt: row.cancelAt,
    nextPlanCode: row.nextPlanCode,
    plan: toPlan(row.plan),
    status: row.status,
    subscribed: true,
  };
}

/**
 * The margin to price an account's turn at: ONE number, the plan's. An
 * account with no subscription row is on PAYG, so it prices at the PAYG
 * row's margin — the same row the ladder on /account/ai shows, so what the
 * page says and what the meter does cannot disagree.
 *
 * The global `ai_margin_percent` setting is the fallback for a deployment
 * with no plan rows at all (a self-hoster, or this repo before migration
 * 0045), and for a turn with no account behind it. It used to be what every
 * un-enrolled account paid, which put the ladder upside down: the default
 * (30%) was a better rate than Maker (50%) — §9.2 item 5.
 *
 * Callers pass `settings` when they already read it, which metering.ts does —
 * this must not become a second settings query on the hot path of every turn.
 */
export async function accountMarginBasisPoints(
  db: LedgerExecutor,
  accountId: string | null | undefined,
  settings: BillingSettings,
): Promise<number> {
  if (!accountId) {
    return settings.marginBasisPoints;
  }
  const { plan } = await readAccountPlan(db, accountId);
  return plan.fromTable ? plan.marginBasisPoints : settings.marginBasisPoints;
}

/** Convenience for callers with no settings in hand. */
export async function readAccountMargin(
  db: LedgerExecutor,
  accountId: string | null | undefined,
  env?: Record<string, string | undefined>,
): Promise<number> {
  const settings = await readBillingSettings(db, env);
  return accountMarginBasisPoints(db, accountId, settings);
}

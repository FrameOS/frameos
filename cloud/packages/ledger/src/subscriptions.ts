import { and, asc, desc, eq, isNull, lte, sql } from "drizzle-orm";
import { subscriptionPeriods, subscriptions } from "@frameos-cloud/db";
import { postEvent, type PostEventOptions } from "./kernel";
import { readPlan, type BillingPlan } from "./plans";
import { divideRoundHalfUp } from "./pricing";
import {
  subscriptionChargeEventType,
  subscriptionRecognitionEventType,
  subscriptionRefundEventType,
} from "./rules/subscription";
import { LedgerError, type LedgerExecutor } from "./types";

// The subscription lifecycle: who is on what plan, and the cycle that charges
// each period at its start and recognizes it at its end.
//
// Everything here is idempotent on a `subscription_periods` row, which is the
// design: the nightly job may run twice in a night, or not at all for three
// days, without double-charging anybody or losing a period. The row is
// created first, then charged, then recognized, and each step stamps its own
// timestamp — so a crash between any two steps leaves work the next run picks
// up rather than a half-charged month nobody can see.
//
// Free plans never get a period row. A $0 charge is not an entry worth
// posting (the kernel refuses a zero amount, and rightly), and an account on
// PAYG is billed entirely through its metered usage.
//
// Three rules that the review (cloud/docs/accounting-todo.md §9.2) added,
// each one a place the first version was wrong:
//
//  * A period never starts before the subscription's `started_at`, and
//    re-subscribing after a cancellation resets `started_at`. Catch-up still
//    opens every month the job missed — but only months the account was
//    subscribed for. It used to bill the gap between a cancellation and a
//    return (item 2).
//  * The first period opens and charges when the subscription is taken, not
//    at the next nightly run: a plan taken and cancelled the same afternoon
//    used to cost nothing (item 6).
//  * An upgrade prorates (refund the unearned remainder, close the period
//    now, open one at the new price); a downgrade waits for the rollover
//    (`next_plan_code`). Recognition earns `price − refunded`, never the full
//    price over a refund (item 6, and the deferred-revenue invariant).

/** One calendar month on from `at`, clamped for short months — a
 *  subscription started on the 31st renews on the 30th, the 28th, and so on,
 *  rather than skipping February. */
export function addMonth(at: Date): Date {
  const year = at.getUTCFullYear();
  const month = at.getUTCMonth();
  const day = at.getUTCDate();
  const lastDayOfNextMonth = new Date(Date.UTC(year, month + 2, 0)).getUTCDate();
  return new Date(
    Date.UTC(
      year,
      month + 1,
      Math.min(day, lastDayOfNextMonth),
      at.getUTCHours(),
      at.getUTCMinutes(),
      at.getUTCSeconds(),
      at.getUTCMilliseconds(),
    ),
  );
}

export interface SubscriptionRecord {
  accountId: string;
  cancelAt: Date | null;
  id: string;
  nextPlanCode: string | null;
  planCode: string;
  startedAt: Date;
  status: string;
}

type SubscriptionRow = typeof subscriptions.$inferSelect;
type PeriodRow = typeof subscriptionPeriods.$inferSelect;

// Whether a subscription row still means anything: cancelled, or past its
// cancel_at, is the same as no row.
function isExpired(row: SubscriptionRow, now: Date): boolean {
  return (
    row.status === "canceled" ||
    (row.cancelAt !== null && row.cancelAt.getTime() <= now.getTime())
  );
}

/**
 * Put an account on a plan.
 *
 * Moving to a free plan is a cancellation, not a subscription: PAYG costs
 * nothing, so there is nothing to bill and no period to open. Otherwise:
 *
 *  - no live subscription: a fresh one from now, with its first period
 *    opened and charged before this returns;
 *  - the same plan (perhaps mid-cancellation): the cancellation and any
 *    pending downgrade are withdrawn, nothing else moves;
 *  - a dearer plan: the unearned rest of the current period is returned to
 *    the receivable, the period is closed now, and a period at the new price
 *    starts now — reverse-and-rebook, prorated;
 *  - a cheaper plan: noted as `next_plan_code` and applied at the rollover.
 *    They keep what they paid for until then.
 */
export async function setAccountPlan(
  db: LedgerExecutor,
  accountId: string,
  planCode: string,
  options: PostEventOptions & { now?: Date | undefined } = {},
): Promise<SubscriptionRecord | null> {
  const plan = await readPlan(db, planCode);
  if (!plan) {
    throw new LedgerError("invalid_draft", `Unknown plan ${planCode}`);
  }
  const now = options.now ?? new Date();
  if (plan.priceMicros === 0n) {
    await cancelAccountPlan(db, accountId, { immediately: true, now });
    return null;
  }

  const [existing] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.accountId, accountId))
    .limit(1);

  if (!existing || isExpired(existing, now)) {
    const [row] = await db
      .insert(subscriptions)
      .values({ accountId, planCode: plan.code, startedAt: now, status: "active" })
      .onConflictDoUpdate({
        set: {
          cancelAt: null,
          canceledAt: null,
          nextPlanCode: null,
          planCode: plan.code,
          // A return after a cancellation starts a NEW run of the
          // subscription: periods before this instant were not served and
          // must not be opened (§9.2 item 2).
          startedAt: now,
          status: "active",
          updatedAt: now,
        },
        target: subscriptions.accountId,
      })
      .returning();
    if (!row) {
      throw new LedgerError("invalid_draft", "Failed to write the subscription");
    }
    await openAndChargePeriodsFor(db, row, now, options);
    return toRecord(row);
  }

  const current = await readPlan(db, existing.planCode);
  const currentPrice = current?.priceMicros ?? 0n;

  if (existing.planCode === plan.code) {
    // Un-cancel, and withdraw any pending downgrade.
    const [row] = await db
      .update(subscriptions)
      .set({ cancelAt: null, canceledAt: null, nextPlanCode: null, status: "active", updatedAt: now })
      .where(eq(subscriptions.id, existing.id))
      .returning();
    return row ? toRecord(row) : null;
  }

  if (plan.priceMicros < currentPrice) {
    // Downgrade: takes effect at the rollover. They keep what they paid for.
    const [row] = await db
      .update(subscriptions)
      .set({ cancelAt: null, canceledAt: null, nextPlanCode: plan.code, status: "active", updatedAt: now })
      .where(eq(subscriptions.id, existing.id))
      .returning();
    return row ? toRecord(row) : null;
  }

  // Upgrade (or a sideways move): prorate the period in progress and start
  // the new plan now.
  const open = await currentPeriod(db, existing.id, now);
  if (open && open.chargedAt) {
    const unearned = unearnedMicros(open, now);
    if (unearned > 0n) {
      await refundUnearnedPeriod(db, open, unearned, options);
    }
    await closePeriodAt(db, open, now);
  } else if (open) {
    // Opened but not yet charged (a cycle that has not run): shorten it to
    // nothing rather than charge a period the account is leaving.
    await db.delete(subscriptionPeriods).where(eq(subscriptionPeriods.id, open.id));
  }
  const [row] = await db
    .update(subscriptions)
    .set({ cancelAt: null, canceledAt: null, nextPlanCode: null, planCode: plan.code, status: "active", updatedAt: now })
    .where(eq(subscriptions.id, existing.id))
    .returning();
  if (!row) {
    throw new LedgerError("invalid_draft", "Failed to write the subscription");
  }
  await openAndChargePeriodsFor(db, row, now, options);
  return toRecord(row);
}

/**
 * Cancel. By default the plan runs to the end of the period already charged
 * for — they owe for it — and stops there. `immediately` is for downgrades
 * to a free plan and for operator action; it does not refund on its own
 * (§3.6's refund recipe is a separate, deliberate step).
 */
export async function cancelAccountPlan(
  db: LedgerExecutor,
  accountId: string,
  options: { immediately?: boolean | undefined; now?: Date | undefined } = {},
): Promise<void> {
  const [row] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.accountId, accountId))
    .limit(1);
  if (!row) {
    return;
  }
  const now = options.now ?? new Date();
  if (options.immediately) {
    await db
      .update(subscriptions)
      .set({ cancelAt: now, canceledAt: now, nextPlanCode: null, status: "canceled", updatedAt: now })
      .where(eq(subscriptions.id, row.id));
    return;
  }
  // Run to the end of the latest period we have charged for. With no charged
  // period there is nothing they paid for, so it ends now.
  const [latest] = await db
    .select()
    .from(subscriptionPeriods)
    .where(eq(subscriptionPeriods.subscriptionId, row.id))
    .orderBy(desc(subscriptionPeriods.periodEnd))
    .limit(1);
  const cancelAt = latest && latest.periodEnd > now ? latest.periodEnd : now;
  await db
    .update(subscriptions)
    .set({ cancelAt, canceledAt: now, nextPlanCode: null, status: "canceling", updatedAt: now })
    .where(eq(subscriptions.id, row.id));
}

/**
 * What account erasure has to do to the books BEFORE the account row goes:
 * return the unearned rest of the period in progress to the receivable,
 * close that period so recognition earns only what was served, and end the
 * subscription. The subscription row itself stays (it holds a bare uuid,
 * like every ledger row) — what must not happen is a charged period
 * vanishing with its deferred revenue still on the books (§9.2 item 4).
 * The receivable that remains is the write-off decision's, not this one's.
 */
export async function closeOutSubscriptionForDeletedAccount(
  db: LedgerExecutor,
  accountId: string,
  options: PostEventOptions & { now?: Date | undefined } = {},
): Promise<void> {
  const now = options.now ?? new Date();
  const [row] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.accountId, accountId))
    .limit(1);
  if (!row) {
    return;
  }
  const open = await currentPeriod(db, row.id, now);
  if (open) {
    if (open.chargedAt) {
      const unearned = unearnedMicros(open, now);
      if (unearned > 0n) {
        await refundUnearnedPeriod(db, open, unearned, options);
      }
      await closePeriodAt(db, open, now);
    } else {
      await db.delete(subscriptionPeriods).where(eq(subscriptionPeriods.id, open.id));
    }
  }
  await cancelAccountPlan(db, accountId, { immediately: true, now });
}

export interface SubscriptionCycleResult {
  charged: number;
  failures: { error: unknown; periodId: string }[];
  opened: number;
  recognized: number;
}

/**
 * The nightly cycle: open the periods that are due, charge the ones that have
 * started, recognize the ones that have ended. Safe to run repeatedly.
 */
export async function runSubscriptionCycle(
  db: LedgerExecutor,
  options: PostEventOptions & { now?: Date | undefined } = {},
): Promise<SubscriptionCycleResult> {
  const now = options.now ?? new Date();
  const result: SubscriptionCycleResult = {
    charged: 0,
    failures: [],
    opened: 0,
    recognized: 0,
  };

  const active = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.status, "active"));
  for (const subscription of active) {
    result.opened += await openDuePeriodsFor(db, subscription, now);
  }

  const uncharged = await db
    .select()
    .from(subscriptionPeriods)
    .where(
      and(
        isNull(subscriptionPeriods.chargedAt),
        lte(subscriptionPeriods.periodStart, now),
      ),
    )
    .orderBy(asc(subscriptionPeriods.periodStart));
  for (const period of uncharged) {
    try {
      await chargePeriod(db, period, options);
      result.charged += 1;
    } catch (error) {
      // One bad period must not stop the rest of the night's work.
      result.failures.push({ error, periodId: period.id });
    }
  }

  const unrecognized = await db
    .select()
    .from(subscriptionPeriods)
    .where(
      and(
        isNull(subscriptionPeriods.recognizedAt),
        lte(subscriptionPeriods.periodEnd, now),
      ),
    )
    .orderBy(asc(subscriptionPeriods.periodEnd));
  for (const period of unrecognized) {
    // A period that was never charged has nothing to recognize — recognizing
    // it would credit revenue against a deferral that does not exist and
    // break the deferred-revenue invariant immediately.
    if (!period.chargedAt) {
      continue;
    }
    try {
      await recognizePeriod(db, period, options);
      result.recognized += 1;
    } catch (error) {
      result.failures.push({ error, periodId: period.id });
    }
  }

  await closeExpiredSubscriptions(db, now);
  return result;
}

// Every period this subscription is due, from where the last one ended (or
// from its start), up to `now`. Catch up rather than skip — a job that has
// not run for two months opens both, because both were served — but never
// from before `started_at`: a return after a cancellation starts fresh, and
// the months in between were not served (§9.2 item 2). A pending downgrade
// takes effect on the first period opened here.
async function openDuePeriodsFor(
  db: LedgerExecutor,
  subscription: SubscriptionRow,
  now: Date,
): Promise<number> {
  let planCode = subscription.planCode;
  let plan = await readPlan(db, planCode);
  if (!plan || plan.priceMicros === 0n) {
    return 0;
  }
  const [latest] = await db
    .select()
    .from(subscriptionPeriods)
    .where(eq(subscriptionPeriods.subscriptionId, subscription.id))
    .orderBy(desc(subscriptionPeriods.periodEnd))
    .limit(1);
  if (latest && latest.periodEnd > now) {
    return 0;
  }
  let periodStart =
    latest && latest.periodEnd > subscription.startedAt
      ? latest.periodEnd
      : subscription.startedAt;

  let opened = 0;
  let guard = 0;
  while (periodStart <= now && guard < 24) {
    if (subscription.nextPlanCode && subscription.nextPlanCode !== planCode) {
      const next = await readPlan(db, subscription.nextPlanCode);
      if (next && next.priceMicros > 0n) {
        planCode = next.code;
        plan = next;
        await db
          .update(subscriptions)
          .set({ nextPlanCode: null, planCode: next.code, updatedAt: now })
          .where(eq(subscriptions.id, subscription.id));
      } else if (next) {
        // Downgrading to a free plan at the rollover is a cancellation.
        await db
          .update(subscriptions)
          .set({ cancelAt: periodStart, canceledAt: now, nextPlanCode: null, status: "canceled", updatedAt: now })
          .where(eq(subscriptions.id, subscription.id));
        return opened;
      }
    }
    const periodEnd = addMonth(periodStart);
    const inserted = await db
      .insert(subscriptionPeriods)
      .values({
        currency: plan.currency,
        marginBasisPoints: plan.marginBasisPoints,
        periodEnd,
        periodStart,
        planCode: plan.code,
        priceMicros: plan.priceMicros,
        subscriptionId: subscription.id,
      })
      .onConflictDoNothing({
        target: [
          subscriptionPeriods.subscriptionId,
          subscriptionPeriods.periodStart,
        ],
      })
      .returning({ id: subscriptionPeriods.id });
    opened += inserted.length;
    periodStart = periodEnd;
    guard += 1;
  }
  return opened;
}

// Open what is due and charge it at once — the path a new or upgraded
// subscription takes, so the receivable is right the moment the plan is.
async function openAndChargePeriodsFor(
  db: LedgerExecutor,
  subscription: SubscriptionRow,
  now: Date,
  options: PostEventOptions,
): Promise<void> {
  await openDuePeriodsFor(db, subscription, now);
  const due = await db
    .select()
    .from(subscriptionPeriods)
    .where(
      and(
        eq(subscriptionPeriods.subscriptionId, subscription.id),
        isNull(subscriptionPeriods.chargedAt),
        lte(subscriptionPeriods.periodStart, now),
      ),
    )
    .orderBy(asc(subscriptionPeriods.periodStart));
  for (const period of due) {
    await chargePeriod(db, period, options);
  }
}

async function currentPeriod(
  db: LedgerExecutor,
  subscriptionId: string,
  now: Date,
): Promise<PeriodRow | undefined> {
  const [row] = await db
    .select()
    .from(subscriptionPeriods)
    .where(
      and(
        eq(subscriptionPeriods.subscriptionId, subscriptionId),
        lte(subscriptionPeriods.periodStart, now),
        sql`${subscriptionPeriods.periodEnd} > ${now.toISOString()}::timestamptz`,
      ),
    )
    .orderBy(desc(subscriptionPeriods.periodStart))
    .limit(1);
  return row;
}

// The part of a period's price that has not been earned yet at `at`,
// pro rata by time, less anything already refunded. Rounded half up once.
export function unearnedMicros(period: PeriodRow, at: Date): bigint {
  const total = BigInt(period.periodEnd.getTime() - period.periodStart.getTime());
  const remaining = BigInt(
    Math.max(0, Math.min(period.periodEnd.getTime(), Math.max(period.periodStart.getTime(), at.getTime())) - period.periodStart.getTime()),
  );
  if (total <= 0n) {
    return 0n;
  }
  const unearned = divideRoundHalfUp(period.priceMicros * (total - remaining), total);
  const left = period.priceMicros - period.refundedMicros;
  return unearned > left ? left : unearned;
}

// Ends a period now. What recognition then earns is price − refunded, which
// after a prorated refund is exactly the part that was served.
async function closePeriodAt(db: LedgerExecutor, period: PeriodRow, at: Date): Promise<void> {
  const end = at.getTime() > period.periodStart.getTime() ? at : new Date(period.periodStart.getTime() + 1);
  await db
    .update(subscriptionPeriods)
    .set({ periodEnd: end })
    .where(eq(subscriptionPeriods.id, period.id));
}

async function subscriptionFor(
  db: LedgerExecutor,
  period: PeriodRow,
): Promise<SubscriptionRow | undefined> {
  const [row] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.id, period.subscriptionId))
    .limit(1);
  return row;
}

async function planNameFor(db: LedgerExecutor, code: string): Promise<string> {
  const plan: BillingPlan | undefined = await readPlan(db, code);
  return plan?.name ?? code;
}

function periodPayload(
  period: PeriodRow,
  planName: string,
): Record<string, unknown> {
  return {
    marginBasisPoints: period.marginBasisPoints,
    periodEnd: period.periodEnd.toISOString(),
    periodId: period.id,
    periodStart: period.periodStart.toISOString(),
    planCode: period.planCode,
    planName,
    // Amounts travel as decimal strings: jsonb has one number type and it
    // loses integers above 2^53 (money.ts says why).
    priceMicros: period.priceMicros.toString(),
  };
}

export async function chargePeriod(
  db: LedgerExecutor,
  period: PeriodRow,
  options: PostEventOptions = {},
): Promise<void> {
  const subscription = await subscriptionFor(db, period);
  if (!subscription) {
    throw new LedgerError("invalid_draft", "Period has no subscription");
  }
  await postEvent(
    db,
    {
      accountId: subscription.accountId,
      eventType: subscriptionChargeEventType,
      idempotencyKey: `subscription_charge:${period.id}`,
      occurredAt: period.periodStart,
      payload: periodPayload(period, await planNameFor(db, period.planCode)),
      source: "subscriptions",
      sourceRef: period.id,
    },
    options,
  );
  await db
    .update(subscriptionPeriods)
    .set({ chargedAt: new Date() })
    .where(eq(subscriptionPeriods.id, period.id));
}

export async function recognizePeriod(
  db: LedgerExecutor,
  period: PeriodRow,
  options: PostEventOptions = {},
): Promise<void> {
  const subscription = await subscriptionFor(db, period);
  if (!subscription) {
    throw new LedgerError("invalid_draft", "Period has no subscription");
  }
  // Re-read: a refund may have landed since the caller loaded the row, and
  // what is earned is what was not refunded.
  const [fresh] = await db
    .select()
    .from(subscriptionPeriods)
    .where(eq(subscriptionPeriods.id, period.id))
    .limit(1);
  const current = fresh ?? period;
  const earned = current.priceMicros - current.refundedMicros;
  if (earned > 0n) {
    await postEvent(
      db,
      {
        accountId: subscription.accountId,
        eventType: subscriptionRecognitionEventType,
        idempotencyKey: `subscription_recognition:${period.id}`,
        // Recognized at the end of the period it was earned over, not tonight:
        // a job that runs late must not move revenue into the wrong month.
        occurredAt: current.periodEnd,
        payload: {
          ...periodPayload(current, await planNameFor(db, current.planCode)),
          priceMicros: earned.toString(),
          refundedMicros: current.refundedMicros.toString(),
        },
        source: "subscriptions",
        sourceRef: period.id,
      },
      options,
    );
  }
  // A fully refunded period has nothing to recognize; it is still done.
  await db
    .update(subscriptionPeriods)
    .set({ recognizedAt: new Date() })
    .where(eq(subscriptionPeriods.id, period.id));
}

/**
 * Return the unearned remainder of a period to the customer's balance — the
 * §3.6 recipe, used by an upgrade's proration and by an operator granting a
 * mid-period refund. Nets against what they owe rather than sending cash.
 * The period remembers what was refunded, so recognition earns the rest and
 * a second refund cannot exceed what is left.
 */
export async function refundUnearnedPeriod(
  db: LedgerExecutor,
  period: PeriodRow,
  amountMicros: bigint,
  options: PostEventOptions = {},
): Promise<void> {
  const subscription = await subscriptionFor(db, period);
  if (!subscription) {
    throw new LedgerError("invalid_draft", "Period has no subscription");
  }
  if (!period.chargedAt) {
    throw new LedgerError("invalid_draft", "Nothing to refund on a period that was never charged");
  }
  if (period.recognizedAt) {
    throw new LedgerError(
      "invalid_draft",
      "This period has already been recognized; refund it with a reversal, not a deferral",
    );
  }
  const left = period.priceMicros - period.refundedMicros;
  if (amountMicros <= 0n || amountMicros > left) {
    throw new LedgerError(
      "invalid_amount",
      `A refund must be positive and no larger than the ${left} micros still deferred for the period`,
    );
  }
  await postEvent(
    db,
    {
      accountId: subscription.accountId,
      eventType: subscriptionRefundEventType,
      // One key per refund, not per period: a second, smaller refund after
      // the first is a second fact, not a replay of the first.
      idempotencyKey: `subscription_refund:${period.id}:${period.refundedMicros.toString()}`,
      occurredAt: new Date(),
      payload: {
        ...periodPayload(period, await planNameFor(db, period.planCode)),
        priceMicros: amountMicros.toString(),
      },
      source: "subscriptions",
      sourceRef: period.id,
    },
    options,
  );
  await db
    .update(subscriptionPeriods)
    .set({ refundedMicros: period.refundedMicros + amountMicros })
    .where(eq(subscriptionPeriods.id, period.id));
}

// A cancellation whose date has passed becomes a real cancellation. Done here
// rather than only on read so the row means what it says, but `readAccountPlan`
// checks the date too — an entitlement must expire on time even when the
// nightly job is broken.
async function closeExpiredSubscriptions(
  db: LedgerExecutor,
  now: Date,
): Promise<void> {
  await db
    .update(subscriptions)
    .set({ status: "canceled", updatedAt: now })
    .where(
      and(
        eq(subscriptions.status, "canceling"),
        lte(subscriptions.cancelAt, now),
      ),
    );
}

function toRecord(row: SubscriptionRow): SubscriptionRecord {
  return {
    accountId: row.accountId,
    cancelAt: row.cancelAt,
    id: row.id,
    nextPlanCode: row.nextPlanCode,
    planCode: row.planCode,
    startedAt: row.startedAt,
    status: row.status,
  };
}

import { and, asc, desc, eq, isNull, lte } from "drizzle-orm";
import { subscriptionPeriods, subscriptions } from "@frameos-cloud/db";
import { postEvent, type PostEventOptions } from "./kernel";
import { readPlan } from "./plans";
import {
  subscriptionChargeEventType,
  subscriptionRecognitionEventType,
  subscriptionRefundEventType,
} from "./rules/subscription";
import { LedgerError, type LedgerExecutor } from "./types";

// The subscription lifecycle: who is on what plan, and the nightly cycle that
// charges each period at its start and recognizes it at its end.
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
  planCode: string;
  startedAt: Date;
  status: string;
}

/**
 * Put an account on a plan. Switching plans keeps the same subscription row —
 * the period rows carry the plan they were billed under, so history survives
 * the change without a second subscription to reconcile against.
 *
 * Moving to PAYG is a cancellation, not a subscription: PAYG costs nothing,
 * so there is nothing to bill and no period to open.
 */
export async function setAccountPlan(
  db: LedgerExecutor,
  accountId: string,
  planCode: string,
): Promise<SubscriptionRecord | null> {
  const plan = await readPlan(db, planCode);
  if (!plan) {
    throw new LedgerError("invalid_draft", `Unknown plan ${planCode}`);
  }
  if (plan.priceMicros === 0n) {
    await cancelAccountPlan(db, accountId, { immediately: true });
    return null;
  }

  const now = new Date();
  const [row] = await db
    .insert(subscriptions)
    .values({ accountId, planCode: plan.code, startedAt: now, status: "active" })
    .onConflictDoUpdate({
      set: {
        // Re-subscribing after a cancellation clears the cancellation: the
        // row is the account's one subscription, not a log of them.
        cancelAt: null,
        canceledAt: null,
        planCode: plan.code,
        status: "active",
        updatedAt: now,
      },
      target: subscriptions.accountId,
    })
    .returning();
  return row ? toRecord(row) : null;
}

/**
 * Cancel. By default the plan runs to the end of the period already charged
 * for — they paid for it — and stops there. `immediately` is for downgrades
 * to a free plan and for operator action; it does not refund on its own
 * (§3.6's refund recipe is a separate, deliberate step).
 */
export async function cancelAccountPlan(
  db: LedgerExecutor,
  accountId: string,
  options: { immediately?: boolean | undefined } = {},
): Promise<void> {
  const [row] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.accountId, accountId))
    .limit(1);
  if (!row) {
    return;
  }
  const now = new Date();
  if (options.immediately) {
    await db
      .update(subscriptions)
      .set({ cancelAt: now, canceledAt: now, status: "canceled", updatedAt: now })
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
  const cancelAt = latest ? latest.periodEnd : now;
  await db
    .update(subscriptions)
    .set({ cancelAt, canceledAt: now, status: "canceling", updatedAt: now })
    .where(eq(subscriptions.id, row.id));
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

  result.opened = await openDuePeriods(db, now);

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
    // break invariant 2 immediately.
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

// Every active subscription that has no period covering `now` gets one. The
// new period starts where the last one ended, so a job that missed three days
// bills a month from the right instant rather than from tonight.
async function openDuePeriods(db: LedgerExecutor, now: Date): Promise<number> {
  const rows = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.status, "active"));
  let opened = 0;
  for (const subscription of rows) {
    const plan = await readPlan(db, subscription.planCode);
    if (!plan || plan.priceMicros === 0n) {
      continue;
    }
    const [latest] = await db
      .select()
      .from(subscriptionPeriods)
      .where(eq(subscriptionPeriods.subscriptionId, subscription.id))
      .orderBy(desc(subscriptionPeriods.periodEnd))
      .limit(1);
    let periodStart = latest ? latest.periodEnd : subscription.startedAt;
    if (latest && latest.periodEnd > now) {
      continue;
    }
    // Catch up rather than skip: a job that has not run for two months opens
    // both months, because both were served.
    let guard = 0;
    while (periodStart <= now && guard < 24) {
      const periodEnd = addMonth(periodStart);
      await db
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
        });
      opened += 1;
      periodStart = periodEnd;
      guard += 1;
    }
  }
  return opened;
}

type PeriodRow = typeof subscriptionPeriods.$inferSelect;

async function subscriptionFor(
  db: LedgerExecutor,
  period: PeriodRow,
): Promise<typeof subscriptions.$inferSelect | undefined> {
  const [row] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.id, period.subscriptionId))
    .limit(1);
  return row;
}

async function planNameFor(db: LedgerExecutor, code: string): Promise<string> {
  const plan = await readPlan(db, code);
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
  await postEvent(
    db,
    {
      accountId: subscription.accountId,
      eventType: subscriptionRecognitionEventType,
      idempotencyKey: `subscription_recognition:${period.id}`,
      // Recognized at the end of the period it was earned over, not tonight:
      // a job that runs late must not move revenue into the wrong month.
      occurredAt: period.periodEnd,
      payload: periodPayload(period, await planNameFor(db, period.planCode)),
      source: "subscriptions",
      sourceRef: period.id,
    },
    options,
  );
  await db
    .update(subscriptionPeriods)
    .set({ recognizedAt: new Date() })
    .where(eq(subscriptionPeriods.id, period.id));
}

/**
 * Return the unearned remainder of a period to the customer's balance — the
 * §3.6 recipe, used by an operator granting a mid-period refund. Nets against
 * what they owe rather than sending cash.
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
  if (amountMicros <= 0n || amountMicros > period.priceMicros) {
    throw new LedgerError(
      "invalid_amount",
      "A refund must be positive and no larger than the period it refunds",
    );
  }
  await postEvent(
    db,
    {
      accountId: subscription.accountId,
      eventType: subscriptionRefundEventType,
      idempotencyKey: `subscription_refund:${period.id}`,
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

function toRecord(row: typeof subscriptions.$inferSelect): SubscriptionRecord {
  return {
    accountId: row.accountId,
    cancelAt: row.cancelAt,
    id: row.id,
    planCode: row.planCode,
    startedAt: row.startedAt,
    status: row.status,
  };
}

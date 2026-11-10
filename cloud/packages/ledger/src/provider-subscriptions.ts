import { and, desc, eq } from "drizzle-orm";
import {
  providerPayments,
  subscriptionPeriods,
  subscriptions,
} from "@frameos-cloud/db";
import { postEvent, type PostEventOptions } from "./kernel";
import { readPlan } from "./plans";
import {
  paymentFeeEventType,
  paymentReceivedEventType,
  paymentRefundedEventType,
} from "./rules/payment";
import {
  addMonth,
  cancelAccountPlan,
  chargePeriod,
  closePeriodAt,
  currentPeriod,
  deferredMicros,
  isExpired,
  refundUnearnedPeriod,
  toRecord,
  unearnedMicros,
  withSubscriptionLock,
  type SubscriptionRecord,
} from "./subscriptions";
import { LedgerError, type LedgerExecutor } from "./types";

// Subscriptions a payment provider bills (cloud/docs/billing.md).
//
// The provider owns the clock: it charges the card, and a period exists here
// because it said a payment for one arrived. So the nightly cycle never
// opens a period for these subscriptions (subscriptions.ts skips them), and
// nothing sits on the receivable waiting for a card that may fail: the
// charge and the payment post together and net to nothing.
//
// A period's price is what the provider collected for it, net of tax, not
// the plan's list price. A discount, a prorated upgrade and a free review
// purchase are then all the same case with a different number.
//
// `post: false` is test mode: the plan is granted and the payment recorded,
// and not one entry reaches the ledger.
//
// Who remits the tax depends on the provider. A merchant of record (Creem)
// keeps it and remits it itself: we never see it as ours. A plain payment
// processor (Stripe) leaves it in our balance, and it is a debt to the tax
// authority from the moment it is collected (`taxRemittedBy: "us"`, booked
// to liability:sales_tax by the payment rules).

export type ProviderMode = "live" | "test";

/** Who pays the tax on a payment over to the tax authority. */
export type TaxRemitter = "provider" | "us";

export interface ProviderPaymentInput {
  accountId: string;
  /** Net of tax, in micros of `currency`. Zero for a fully discounted period. */
  amountMicros: bigint;
  currency?: string | undefined;
  mode: ProviderMode;
  occurredAt?: Date | undefined;
  /** The bounds of the period the provider says this payment bought. */
  periodEnd: Date;
  periodStart: Date;
  planCode: string;
  post: boolean;
  provider: string;
  /** The provider's subscription id, kept on the payment row. */
  subscriptionId?: string | null | undefined;
  taxMicros?: bigint | undefined;
  /** "provider" (the default) for a merchant of record, "us" otherwise. */
  taxRemittedBy?: TaxRemitter | undefined;
  /** The provider's transaction id: a payment is applied once per id. */
  transactionId: string;
  /**
   * The provider's handle on the money itself (Stripe: the charge), when it
   * differs from the transaction id. A refund or a fee names it.
   */
  paymentRef?: string | null | undefined;
  /** Provider-specific facts kept for a person (an invoice number). */
  details?: Record<string, unknown> | undefined;
}

export interface ProviderPaymentResult {
  /** False when this transaction was applied before. */
  applied: boolean;
  periodId: string | null;
  /**
   * The plan the account was on when this payment arrived, read under the
   * subscription lock: null when it had none running (never subscribed, or
   * ended). A caller tells a first purchase, a renewal and a change apart by
   * it. Null when the payment was not applied.
   */
  previous: { planCode: string; provider: string | null } | null;
  subscription: SubscriptionRecord | null;
}

// A renewal's period starts where the last one ended, give or take the
// provider's clock. Anything starting earlier than this before the running
// period's end is a change in the middle of it.
const renewalToleranceMs = 24 * 60 * 60 * 1000;

/**
 * The provider collected a payment for a plan: put the account on it and
 * book the period.
 *
 *  - a first payment, or a renewal: a period with the provider's bounds;
 *  - a payment in the middle of a running period (an upgrade's prorated
 *    charge): the unearned rest of the running period goes back to the
 *    receivable, that period closes now, and the new one runs from now to
 *    the provider's period end, priced at what was carried over plus what
 *    was just paid.
 *
 * Either way the receivable ends where it started.
 */
export async function applyProviderPayment(
  db: LedgerExecutor,
  input: ProviderPaymentInput,
  options: PostEventOptions & { now?: Date | undefined } = {},
): Promise<ProviderPaymentResult> {
  return withSubscriptionLock(db, input.accountId, async (tx) => {
    const now = options.now ?? new Date();
    const plan = await readPlan(tx, input.planCode);
    if (!plan || plan.priceMicros === 0n) {
      throw new LedgerError("invalid_draft", `${input.planCode} is not a paid plan`);
    }
    if (input.amountMicros < 0n) {
      throw new LedgerError("invalid_amount", "A payment cannot be negative");
    }
    const currency = input.currency ?? plan.currency;
    if (currency !== plan.currency) {
      throw new LedgerError(
        "invalid_draft",
        `Payment in ${currency} for a plan priced in ${plan.currency}`,
      );
    }

    const taxRemittedBy = input.taxRemittedBy ?? "provider";
    const taxMicros = input.taxMicros ?? 0n;
    if (taxMicros < 0n) {
      throw new LedgerError("invalid_amount", "Tax on a payment cannot be negative");
    }
    const [payment] = await tx
      .insert(providerPayments)
      .values({
        accountId: input.accountId,
        amountMicros: input.amountMicros,
        currency,
        details: input.details ?? {},
        kind: "payment",
        mode: input.mode,
        occurredAt: input.occurredAt ?? now,
        paymentRef: input.paymentRef ?? null,
        planCode: plan.code,
        posted: input.post,
        provider: input.provider,
        subscriptionId: input.subscriptionId ?? null,
        taxMicros,
        taxRemittedBy,
        transactionId: input.transactionId,
      })
      .onConflictDoNothing()
      .returning({ id: providerPayments.id });
    if (!payment) {
      return { applied: false, periodId: null, previous: null, subscription: null };
    }

    const [existing] = await tx
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.accountId, input.accountId))
      .limit(1);
    const previous =
      existing && !isExpired(existing, now)
        ? { planCode: existing.planCode, provider: existing.provider }
        : null;
    const startedAt = input.periodStart < now ? input.periodStart : now;
    const [row] =
      !existing || isExpired(existing, now)
        ? await tx
            .insert(subscriptions)
            .values({
              accountId: input.accountId,
              planCode: plan.code,
              provider: input.provider,
              startedAt,
              status: "active",
            })
            .onConflictDoUpdate({
              set: {
                cancelAt: null,
                canceledAt: null,
                nextPlanCode: null,
                planCode: plan.code,
                provider: input.provider,
                startedAt,
                status: "active",
                updatedAt: now,
              },
              target: subscriptions.accountId,
            })
            .returning()
        : await tx
            .update(subscriptions)
            .set({
              nextPlanCode: null,
              planCode: plan.code,
              provider: input.provider,
              updatedAt: now,
            })
            .where(eq(subscriptions.id, existing.id))
            .returning();
    if (!row) {
      throw new LedgerError("invalid_draft", "Failed to write the subscription");
    }

    const paid = input.post ? input.amountMicros : 0n;
    let start = input.periodStart;
    let carried = 0n;
    const running = await currentPeriod(tx, row.id, now);
    if (running && !running.chargedAt) {
      // Opened by the nightly cycle before the provider took over and never
      // charged: the provider's period replaces it.
      await tx.delete(subscriptionPeriods).where(eq(subscriptionPeriods.id, running.id));
    } else if (running) {
      const renewal =
        input.periodStart.getTime() >= running.periodEnd.getTime() - renewalToleranceMs;
      if (renewal) {
        start = running.periodEnd > input.periodStart ? running.periodEnd : input.periodStart;
      } else {
        if (!running.recognizedAt) {
          const unearned = unearnedMicros(running, now);
          if (unearned > 0n) {
            await refundUnearnedPeriod(tx, running, unearned, options);
            carried = unearned;
          }
        }
        await closePeriodAt(tx, running, now);
        start = now;
      }
    }
    const end = input.periodEnd > start ? input.periodEnd : addMonth(start);

    const [period] = await tx
      .insert(subscriptionPeriods)
      .values({
        currency: plan.currency,
        marginBasisPoints: plan.marginBasisPoints,
        periodEnd: end,
        periodStart: start,
        planCode: plan.code,
        priceMicros: paid + carried,
        subscriptionId: row.id,
      })
      .onConflictDoNothing({
        target: [subscriptionPeriods.subscriptionId, subscriptionPeriods.periodStart],
      })
      .returning();
    if (!period) {
      throw new LedgerError(
        "invalid_draft",
        `A period starting ${start.toISOString()} already exists for this subscription`,
      );
    }
    if (period.priceMicros > 0n) {
      await chargePeriod(tx, period, options);
    } else {
      // Nothing was collected, so there is nothing to defer or to earn.
      await tx
        .update(subscriptionPeriods)
        .set({ chargedAt: now, recognizedAt: now })
        .where(eq(subscriptionPeriods.id, period.id));
    }
    if (paid > 0n) {
      await postEvent(
        tx,
        {
          accountId: input.accountId,
          eventType: paymentReceivedEventType,
          idempotencyKey: `payment:${input.provider}:${input.mode}:${input.transactionId}`,
          occurredAt: input.occurredAt ?? now,
          payload: {
            amountMicros: paid.toString(),
            paymentRef: input.transactionId,
            periodId: period.id,
            planCode: plan.code,
            provider: input.provider,
            // The tax we collected and owe. A merchant of record's is not ours.
            ...(taxRemittedBy === "us" && taxMicros > 0n
              ? { taxMicros: taxMicros.toString() }
              : {}),
          },
          source: "payments",
          sourceRef: input.transactionId,
        },
        options,
      );
    }
    await tx
      .update(providerPayments)
      .set({ periodId: period.id })
      .where(eq(providerPayments.id, payment.id));
    return { applied: true, periodId: period.id, previous, subscription: toRecord(row) };
  });
}

export interface ProviderRefundInput {
  accountId: string;
  /** Net of tax. */
  amountMicros: bigint;
  currency?: string | undefined;
  mode: ProviderMode;
  occurredAt?: Date | undefined;
  /** The transaction the refund hands back. */
  paymentTransactionId: string;
  post: boolean;
  provider: string;
  /** The provider's refund id: a refund is applied once per id. */
  refundId: string;
  /** The tax handed back with it. Who remits it follows the payment. */
  taxMicros?: bigint | undefined;
  details?: Record<string, unknown> | undefined;
}

/**
 * The provider handed a payment back, in full or in part. What is still
 * deferred for the period it bought leaves the deferral; the part already
 * earned comes out of revenue. Access is a separate matter: a refunded
 * subscription is cancelled by its own event.
 */
export async function applyProviderRefund(
  db: LedgerExecutor,
  input: ProviderRefundInput,
  options: PostEventOptions & { now?: Date | undefined } = {},
): Promise<{ applied: boolean }> {
  return withSubscriptionLock(db, input.accountId, async (tx) => {
    const now = options.now ?? new Date();
    if (input.amountMicros < 0n) {
      throw new LedgerError("invalid_amount", "A refund cannot be negative");
    }
    const [paymentRow] = await tx
      .select()
      .from(providerPayments)
      .where(
        and(
          eq(providerPayments.provider, input.provider),
          eq(providerPayments.mode, input.mode),
          eq(providerPayments.kind, "payment"),
          eq(providerPayments.transactionId, input.paymentTransactionId),
        ),
      )
      .limit(1);
    if (!paymentRow) {
      // Handing back money the books never received would invent a negative
      // balance at the provider. A person has to look at this one.
      throw new LedgerError(
        "invalid_draft",
        `Refund ${input.refundId} is for a payment the books do not hold (${input.paymentTransactionId})`,
      );
    }
    const taxMicros = input.taxMicros ?? 0n;
    if (taxMicros < 0n) {
      throw new LedgerError("invalid_amount", "Tax on a refund cannot be negative");
    }
    const [refund] = await tx
      .insert(providerPayments)
      .values({
        accountId: input.accountId,
        amountMicros: input.amountMicros,
        currency: input.currency ?? paymentRow.currency,
        details: input.details ?? {},
        kind: "refund",
        mode: input.mode,
        occurredAt: input.occurredAt ?? now,
        paymentRef: paymentRow.paymentRef,
        periodId: paymentRow.periodId,
        planCode: paymentRow.planCode,
        posted: input.post && paymentRow.posted,
        provider: input.provider,
        subscriptionId: paymentRow.subscriptionId,
        taxMicros,
        taxRemittedBy: paymentRow.taxRemittedBy,
        transactionId: input.refundId,
      })
      .onConflictDoNothing()
      .returning({ id: providerPayments.id });
    if (!refund) {
      return { applied: false };
    }
    if (!input.post || !paymentRow.posted || input.amountMicros === 0n) {
      return { applied: true };
    }

    let unearned = 0n;
    if (paymentRow.periodId) {
      const [period] = await tx
        .select()
        .from(subscriptionPeriods)
        .where(eq(subscriptionPeriods.id, paymentRow.periodId))
        .limit(1);
      if (period && period.chargedAt && !period.recognizedAt) {
        const left = deferredMicros(period);
        unearned = input.amountMicros < left ? input.amountMicros : left;
        if (unearned > 0n) {
          await refundUnearnedPeriod(tx, period, unearned, options);
        }
      }
    }
    await postEvent(
      tx,
      {
        accountId: input.accountId,
        eventType: paymentRefundedEventType,
        idempotencyKey: `refund:${input.provider}:${input.mode}:${input.refundId}`,
        occurredAt: input.occurredAt ?? now,
        payload: {
          amountMicros: input.amountMicros.toString(),
          earnedMicros: (input.amountMicros - unearned).toString(),
          paymentRef: input.paymentTransactionId,
          periodId: paymentRow.periodId,
          planCode: paymentRow.planCode,
          provider: input.provider,
          refundRef: input.refundId,
          ...(paymentRow.taxRemittedBy === "us" && taxMicros > 0n
            ? { taxMicros: taxMicros.toString() }
            : {}),
        },
        source: "payments",
        sourceRef: input.refundId,
      },
      options,
    );
    return { applied: true };
  });
}

export interface ProviderFeeInput {
  accountId: string;
  /** In micros of `currency` (the plan's currency, converted if need be). */
  amountMicros: bigint;
  currency?: string | undefined;
  /** What the fee was converted from, kept for a person (Stripe's balance
   *  settles in the account's own currency). */
  details?: Record<string, unknown> | undefined;
  /** The provider's id for this fee: applied once per id. */
  feeId: string;
  mode: ProviderMode;
  occurredAt?: Date | undefined;
  /** The money it was charged on (Stripe: the charge). */
  paymentRef?: string | null | undefined;
  planCode?: string | null | undefined;
  post: boolean;
  provider: string;
  subscriptionId?: string | null | undefined;
}

/**
 * The provider kept a fee for moving money: a card payment's processing
 * fee, or a dispute's. A cost of collecting, booked against the provider's
 * balance (expense:psp_fees); the customer owes nothing for it.
 */
export async function applyProviderFee(
  db: LedgerExecutor,
  input: ProviderFeeInput,
  options: PostEventOptions & { now?: Date | undefined } = {},
): Promise<{ applied: boolean }> {
  return withSubscriptionLock(db, input.accountId, async (tx) => {
    const now = options.now ?? new Date();
    if (input.amountMicros < 0n) {
      throw new LedgerError("invalid_amount", "A fee cannot be negative");
    }
    const [row] = await tx
      .insert(providerPayments)
      .values({
        accountId: input.accountId,
        amountMicros: input.amountMicros,
        currency: input.currency ?? "USD",
        details: input.details ?? {},
        kind: "fee",
        mode: input.mode,
        occurredAt: input.occurredAt ?? now,
        paymentRef: input.paymentRef ?? null,
        planCode: input.planCode ?? null,
        posted: input.post,
        provider: input.provider,
        subscriptionId: input.subscriptionId ?? null,
        transactionId: input.feeId,
      })
      .onConflictDoNothing()
      .returning({ id: providerPayments.id });
    if (!row) {
      return { applied: false };
    }
    if (input.post && input.amountMicros > 0n) {
      await postEvent(
        tx,
        {
          accountId: input.accountId,
          eventType: paymentFeeEventType,
          idempotencyKey: `fee:${input.provider}:${input.mode}:${input.feeId}`,
          occurredAt: input.occurredAt ?? now,
          payload: {
            amountMicros: input.amountMicros.toString(),
            feeRef: input.feeId,
            ...(input.paymentRef ? { paymentRef: input.paymentRef } : {}),
            ...(input.planCode ? { planCode: input.planCode } : {}),
            provider: input.provider,
            ...(input.details?.["settlement"] !== undefined
              ? { settlement: input.details["settlement"] }
              : {}),
          },
          source: "payments",
          sourceRef: input.feeId,
        },
        options,
      );
    }
    return { applied: true };
  });
}

/**
 * The provider will bill a cheaper plan from the next renewal. The account
 * keeps what it paid for until then; this only names where it is going
 * (null: nowhere, the change was withdrawn). The plan itself moves when the
 * renewal's payment arrives. True when this call is what moved it.
 */
export async function noteProviderNextPlan(
  db: LedgerExecutor,
  accountId: string,
  provider: string,
  planCode: string | null,
): Promise<boolean> {
  return withSubscriptionLock(db, accountId, async (tx) => {
    const [row] = await tx
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.accountId, accountId))
      .limit(1);
    if (!row || row.provider !== provider || row.status === "canceled") {
      return false;
    }
    const next = planCode && planCode !== row.planCode ? planCode : null;
    if (row.nextPlanCode === next) {
      return false;
    }
    await tx
      .update(subscriptions)
      .set({ nextPlanCode: next, updatedAt: new Date() })
      .where(eq(subscriptions.id, row.id));
    return true;
  });
}

export type ProviderSubscriptionState =
  /** Paying and renewing; also what a withdrawn cancellation returns to. */
  | { kind: "active" }
  /** Ended at the provider. The plan stops now; a paid period is still earned. */
  | { kind: "canceled" }
  /** Runs to the end of the period paid for, then stops. */
  | { cancelAt?: Date | null | undefined; kind: "scheduled" };

/**
 * Follow the provider's subscription state. Only a subscription that
 * provider bills is touched: a plan an operator set by hand is not the
 * provider's to end.
 */
export async function setProviderSubscriptionState(
  db: LedgerExecutor,
  accountId: string,
  provider: string,
  state: ProviderSubscriptionState,
  options: { now?: Date | undefined } = {},
): Promise<void> {
  await withSubscriptionLock(db, accountId, async (tx) => {
    const now = options.now ?? new Date();
    const [row] = await tx
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.accountId, accountId))
      .limit(1);
    if (!row || row.provider !== provider || row.status === "canceled") {
      return;
    }
    if (state.kind === "canceled") {
      await cancelAccountPlan(tx, accountId, { immediately: true, now });
      return;
    }
    if (state.kind === "active") {
      if (row.status !== "active" || row.cancelAt) {
        await tx
          .update(subscriptions)
          .set({ cancelAt: null, canceledAt: null, status: "active", updatedAt: now })
          .where(eq(subscriptions.id, row.id));
      }
      return;
    }
    const [latest] = await tx
      .select()
      .from(subscriptionPeriods)
      .where(eq(subscriptionPeriods.subscriptionId, row.id))
      .orderBy(desc(subscriptionPeriods.periodEnd))
      .limit(1);
    const paidUntil = latest && latest.periodEnd > now ? latest.periodEnd : now;
    const cancelAt = state.cancelAt && state.cancelAt > now ? state.cancelAt : paidUntil;
    await tx
      .update(subscriptions)
      .set({
        cancelAt,
        canceledAt: row.canceledAt ?? now,
        nextPlanCode: null,
        status: "canceling",
        updatedAt: now,
      })
      .where(eq(subscriptions.id, row.id));
  });
}

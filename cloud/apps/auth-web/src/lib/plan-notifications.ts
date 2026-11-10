// Server-side PostHog events for a paid plan's life: a purchase, a renewal, a
// change, a cancellation and its end, a failed payment, a refund, a dispute.
// The "Cloud plans" PostHog workflow posts each one's `summary` to the
// Discord reports channel (docs/deployment.md, "Operational
// Notifications"); nothing here talks to Discord.
//
// Each fires once per change, however many times Stripe's state is applied
// (the checkout return, a burst of webhooks, the nightly reconcile):
// billing-provider.ts calls these only where its own write is the one that
// changed something (a payment applied, a status moved by compare-and-set,
// a refund recorded, a webhook processed).
//
// The account is the distinct id and nothing names the person: the ledger
// keeps a uuid alone on purpose, and `admin_url` (the customer statement)
// is where an operator sees who it is.

import type { BillingPlan } from "@frameos-cloud/ledger";
import { getAccountBaseUrl } from "./env";
import { capturePostHogEvent } from "./posthog-capture";

export const planEvents = {
  cancellationScheduled: "cloud plan cancellation scheduled",
  cancellationWithdrawn: "cloud plan cancellation withdrawn",
  changed: "cloud plan changed",
  disputeClosed: "cloud plan dispute closed",
  disputeOpened: "cloud plan dispute opened",
  downgradeScheduled: "cloud plan downgrade scheduled",
  ended: "cloud plan ended",
  paymentFailed: "cloud plan payment failed",
  paymentReceived: "cloud plan payment received",
  refunded: "cloud plan refunded",
  renewed: "cloud plan renewed",
  subscribed: "cloud plan subscribed",
} as const;

export type PlanEventName = (typeof planEvents)[keyof typeof planEvents];

type PlanRef = Pick<BillingPlan, "code" | "currency" | "name" | "period" | "priceMicros">;

interface Money {
  /** Collected or handed back, tax included, in cents of `currency`. */
  amountCents: number;
  currency: string;
  /** The tax in `amountCents`. */
  taxCents?: number | undefined;
}

export type PlanNotice = {
  accountId: string;
  mode: "live" | "test";
  subscriptionId?: string | null | undefined;
} & (
  | ({
      /** A paid invoice: the first, a renewal, or one in between. */
      kind: "payment";
      billingReason: string | null;
      invoiceId: string;
      plan: PlanRef;
      /** The plan the account was on before; null for a first purchase. */
      previous: PlanRef | null;
    } & Money)
  | {
      /** A larger plan Stripe moved to before any invoice for it was paid. */
      kind: "switched";
      plan: PlanRef;
      previous: PlanRef;
    }
  | { kind: "downgrade_scheduled"; plan: PlanRef; previous: PlanRef; at: Date | null }
  | { kind: "cancellation_scheduled"; plan: PlanRef; at: Date | null }
  | { kind: "cancellation_withdrawn"; plan: PlanRef }
  | {
      kind: "ended";
      plan: PlanRef;
      /** scheduled: the cancellation ran out; payment_failed: Stripe gave
       * up on the card; canceled: ended at once in Stripe; account_deleted:
       * ended by the account's erasure. */
      reason: "account_deleted" | "canceled" | "payment_failed" | "scheduled";
    }
  | { kind: "payment_failed"; plan: PlanRef }
  | ({ kind: "refunded"; plan: PlanRef | null; refundId: string } & Money)
  | ({ kind: "dispute_opened"; disputeId: string; plan: PlanRef | null; reason: string | null } & Money)
  | ({ kind: "dispute_closed"; disputeId: string; plan: PlanRef | null; status: string | null } & Money)
);

function money(cents: number, currency: string) {
  try {
    return new Intl.NumberFormat("en-US", {
      currency,
      maximumFractionDigits: 2,
      minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
      style: "currency",
    }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

function planLabel(plan: PlanRef | null) {
  if (!plan) {
    return "a plan";
  }
  const cents = Number(plan.priceMicros / 10_000n);
  return `${plan.name} ${money(cents, plan.currency)}/${plan.period}`;
}

function paid(notice: Money) {
  const total = money(notice.amountCents, notice.currency);
  return notice.taxCents ? `${total} paid incl. ${money(notice.taxCents, notice.currency)} tax` : `${total} paid`;
}

function day(date: Date | null) {
  return date ? date.toISOString().slice(0, 10) : "the end of the period";
}

const endReasons = {
  account_deleted: "the account was deleted",
  canceled: "cancelled in Stripe",
  payment_failed: "Stripe gave up on the card",
  scheduled: "the cancellation ran out",
} as const;

/** The event and the properties it carries. Pure, for the tests. */
export function planEventCapture(notice: PlanNotice): {
  event: PlanEventName;
  properties: Record<string, unknown>;
} {
  let event: PlanEventName;
  let summary: string;
  const extra: Record<string, unknown> = {};
  switch (notice.kind) {
    case "payment": {
      const previous = notice.previous;
      if (!previous) {
        event = planEvents.subscribed;
        summary = `🎉 New subscription: ${planLabel(notice.plan)}, ${paid(notice)}`;
      } else if (previous.code !== notice.plan.code) {
        event = planEvents.changed;
        const up = notice.plan.priceMicros > previous.priceMicros;
        summary = `${up ? "⬆️ Upgrade" : "⬇️ Downgrade"}: ${planLabel(previous)} → ${planLabel(notice.plan)}, ${paid(notice)}`;
      } else if (notice.billingReason === "subscription_cycle") {
        event = planEvents.renewed;
        summary = `🔁 Renewal: ${planLabel(notice.plan)}, ${paid(notice)}`;
      } else {
        event = planEvents.paymentReceived;
        summary = `💶 Payment: ${planLabel(notice.plan)}, ${paid(notice)} (${notice.billingReason ?? "no reason given"})`;
      }
      Object.assign(extra, {
        amount: notice.amountCents / 100,
        billing_reason: notice.billingReason,
        currency: notice.currency,
        from_plan_code: previous?.code,
        invoice_id: notice.invoiceId,
        tax: (notice.taxCents ?? 0) / 100,
      });
      break;
    }
    case "switched":
      event = planEvents.changed;
      summary = `⬆️ Upgrade: ${planLabel(notice.previous)} → ${planLabel(notice.plan)}, charge to follow`;
      extra["from_plan_code"] = notice.previous.code;
      break;
    case "downgrade_scheduled":
      event = planEvents.downgradeScheduled;
      summary = `↘️ Downgrade scheduled: ${planLabel(notice.previous)} → ${planLabel(notice.plan)} on ${day(notice.at)}`;
      extra["from_plan_code"] = notice.previous.code;
      extra["at"] = notice.at?.toISOString();
      break;
    case "cancellation_scheduled":
      event = planEvents.cancellationScheduled;
      summary = `👋 Cancellation: ${planLabel(notice.plan)} ends ${day(notice.at)}`;
      extra["at"] = notice.at?.toISOString();
      break;
    case "cancellation_withdrawn":
      event = planEvents.cancellationWithdrawn;
      summary = `↩️ Cancellation taken back: ${planLabel(notice.plan)} renews again`;
      break;
    case "ended":
      event = planEvents.ended;
      summary = `🛑 Plan ended: ${planLabel(notice.plan)}, ${endReasons[notice.reason]}`;
      extra["reason"] = notice.reason;
      break;
    case "payment_failed":
      event = planEvents.paymentFailed;
      summary = `⚠️ Payment failed: ${planLabel(notice.plan)}, Stripe is retrying the card`;
      break;
    case "refunded":
      event = planEvents.refunded;
      summary = `💸 Refund: ${money(notice.amountCents, notice.currency)} on ${planLabel(notice.plan)}`;
      Object.assign(extra, {
        amount: notice.amountCents / 100,
        currency: notice.currency,
        refund_id: notice.refundId,
        tax: (notice.taxCents ?? 0) / 100,
      });
      break;
    case "dispute_opened":
      event = planEvents.disputeOpened;
      summary = `🚨 Dispute opened: ${money(notice.amountCents, notice.currency)} on ${planLabel(notice.plan)} (${notice.reason ?? "no reason given"}). Answer it in Stripe before its deadline.`;
      Object.assign(extra, {
        amount: notice.amountCents / 100,
        currency: notice.currency,
        dispute_id: notice.disputeId,
        reason: notice.reason,
      });
      break;
    case "dispute_closed":
      event = planEvents.disputeClosed;
      summary = `⚖️ Dispute ${notice.status ?? "closed"}: ${money(notice.amountCents, notice.currency)} on ${planLabel(notice.plan)}`;
      Object.assign(extra, {
        amount: notice.amountCents / 100,
        currency: notice.currency,
        dispute_id: notice.disputeId,
        status: notice.status,
      });
      break;
  }
  const adminUrl = new URL("/admin/billing/customers", getAccountBaseUrl());
  adminUrl.searchParams.set("account", notice.accountId);
  return {
    event,
    properties: {
      ...extra,
      admin_url: adminUrl.toString(),
      mode: notice.mode,
      plan_code: notice.plan?.code,
      plan_name: notice.plan?.name,
      provider: "stripe",
      subscription_id: notice.subscriptionId ?? undefined,
      // What Discord shows. A test-mode payment is an operator's check.
      summary: notice.mode === "test" ? `[test] ${summary}` : summary,
    },
  };
}

// Never throws and never waits on PostHog; safe to call without awaiting.
export function notifyPlanEvent(notice: PlanNotice): Promise<void> {
  const { event, properties } = planEventCapture(notice);
  return capturePostHogEvent(event, notice.accountId, properties);
}

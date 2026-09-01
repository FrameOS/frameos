import { customerReceivableCode, systemAccountCodes } from "../chart";
import { parseMicros } from "../money";
import {
  LedgerError,
  type EntryDraft,
  type FinancialEventRecord,
  type PostingRule,
} from "../types";

// Subscriptions, as accounting (§3.6). Three recipes, and each one is two
// legs, because postpay made this simple: there is no prepaid balance to
// charge from, so a subscription is just another thing that lands on the
// same receivable the metered AI lands on, and the same month-end invoice
// collects both.
//
//   'subscription_charge'        at period start — they now owe us for it
//     Dr asset:receivable:customer:<id>
//     Cr liability:deferred:subscriptions
//
//   'subscription_recognition'   at period end — we have now earned it
//     Dr liability:deferred:subscriptions
//     Cr revenue:subscriptions
//
//   'subscription_refund'        cancel with time unearned
//     Dr liability:deferred:subscriptions
//     Cr asset:receivable:customer:<id>
//
// Charging and recognizing are deliberately separate. It is the separation
// that keeps the unearned remainder of every period sitting in
// `liability:deferred:subscriptions` where a proration can find it — and it
// is why the refund recipe needs no new accounts and no new model.
//
// Note what is NOT here: the plan's margin. A plan changes what price the
// metering computes for a turn, and `rules/ai-usage.ts` never learns that
// plans exist. If a ladder needs a posting rule, it is the wrong ladder.

export const subscriptionChargeEventType = "subscription.charged";
export const subscriptionRecognitionEventType = "subscription.recognized";
export const subscriptionRefundEventType = "subscription.refunded";

function amountAndAccount(event: FinancialEventRecord): {
  accountId: string;
  amountMicros: bigint;
  metadata: Record<string, unknown>;
} {
  const amountMicros = parseMicros(
    event.payload["priceMicros"] ?? 0,
    "priceMicros",
  );
  if (amountMicros <= 0n) {
    throw new LedgerError(
      "invalid_amount",
      "A subscription entry must move a positive amount",
    );
  }
  // The account is on the event rather than in the payload: it is the column
  // the ledger indexes and the one thing that survives the customer's
  // deletion (§2.1).
  if (!event.accountId) {
    throw new LedgerError(
      "invalid_draft",
      "A subscription entry must name the account it belongs to",
    );
  }
  const pick = (key: string) =>
    event.payload[key] === undefined ? {} : { [key]: event.payload[key] };
  return {
    accountId: event.accountId,
    amountMicros,
    metadata: {
      ...pick("marginBasisPoints"),
      ...pick("periodEnd"),
      ...pick("periodId"),
      ...pick("periodStart"),
      ...pick("planCode"),
      ...pick("planName"),
      priceMicros: String(event.payload["priceMicros"] ?? 0),
    },
  };
}

export const subscriptionChargeRule: PostingRule = {
  build(event: FinancialEventRecord): EntryDraft[] {
    const { accountId, amountMicros, metadata } = amountAndAccount(event);
    const planName =
      typeof event.payload["planName"] === "string"
        ? event.payload["planName"]
        : (event.payload["planCode"] ?? "subscription");
    return [
      {
        description: `${planName} subscription`,
        entryType: "subscription_charge",
        metadata,
        occurredAt: event.occurredAt,
        postings: [
          {
            accountCode: customerReceivableCode(accountId),
            amountMicros,
            direction: "debit",
          },
          {
            accountCode: systemAccountCodes.deferredSubscriptions,
            amountMicros,
            direction: "credit",
          },
        ],
      },
    ];
  },
  name: "subscription_charge",
  version: 1,
};

export const subscriptionRecognitionRule: PostingRule = {
  build(event: FinancialEventRecord): EntryDraft[] {
    const { amountMicros, metadata } = amountAndAccount(event);
    return [
      {
        description: "Subscription revenue recognized",
        entryType: "subscription_recognition",
        metadata,
        occurredAt: event.occurredAt,
        postings: [
          {
            accountCode: systemAccountCodes.deferredSubscriptions,
            amountMicros,
            direction: "debit",
          },
          {
            accountCode: systemAccountCodes.revenueSubscriptions,
            amountMicros,
            direction: "credit",
          },
        ],
      },
    ];
  },
  name: "subscription_recognition",
  version: 1,
};

// Cancelling with time unearned: net it against what they owe rather than
// sending cash. Under postpay that is usually the entire answer — the cash
// path (refunds_payable → psp) stays on the shelf for somebody who has
// already paid and is leaving.
export const subscriptionRefundRule: PostingRule = {
  build(event: FinancialEventRecord): EntryDraft[] {
    const { accountId, amountMicros, metadata } = amountAndAccount(event);
    return [
      {
        description: "Unearned subscription returned to the customer's balance",
        entryType: "subscription_refund_to_receivable",
        metadata,
        occurredAt: event.occurredAt,
        postings: [
          {
            accountCode: systemAccountCodes.deferredSubscriptions,
            amountMicros,
            direction: "debit",
          },
          {
            accountCode: customerReceivableCode(accountId),
            amountMicros,
            direction: "credit",
          },
        ],
      },
    ];
  },
  name: "subscription_refund",
  version: 1,
};

import { customerReceivableCode, systemAccountCodes } from "../chart";
import { parseMicros } from "../money";
import {
  LedgerError,
  type EntryDraft,
  type FinancialEventRecord,
  type PostingRule,
} from "../types";

// Money through the payment provider (§3.2). The provider is a merchant of
// record: it charges the customer, keeps the tax and pays us out, so every
// amount here is net of tax. Its own fee is not in a payment notice; that
// is booked from the payout report (expense:psp_fees, Phase 6).
//
//   'payment.received'   the provider collected what the customer owed
//     Dr asset:psp:main
//     Cr asset:receivable:customer:<id>
//
//   'payment.refunded'   the provider handed money back
//     Dr asset:receivable:customer:<id>
//     Cr asset:psp:main
//   and, for the part of it we had already earned,
//     Dr revenue:subscriptions
//     Cr asset:receivable:customer:<id>
//
// The unearned part of a refund comes out of the deferral through the
// subscription refund recipe, which credits the receivable; the cash leg
// here debits it again, so a refund leaves the customer owing nothing.

export const paymentReceivedEventType = "payment.received";
export const paymentRefundedEventType = "payment.refunded";

function amountAndAccount(event: FinancialEventRecord): {
  accountId: string;
  amountMicros: bigint;
  metadata: Record<string, unknown>;
} {
  const amountMicros = parseMicros(event.payload["amountMicros"] ?? 0, "amountMicros");
  if (amountMicros <= 0n) {
    throw new LedgerError("invalid_amount", "A payment entry must move a positive amount");
  }
  if (!event.accountId) {
    throw new LedgerError(
      "invalid_draft",
      "A payment entry must name the account it belongs to",
    );
  }
  const pick = (key: string) =>
    event.payload[key] === undefined ? {} : { [key]: event.payload[key] };
  return {
    accountId: event.accountId,
    amountMicros,
    metadata: {
      ...pick("paymentRef"),
      ...pick("periodId"),
      ...pick("planCode"),
      ...pick("provider"),
      ...pick("refundRef"),
    },
  };
}

export const paymentReceivedRule: PostingRule = {
  build(event: FinancialEventRecord): EntryDraft[] {
    const { accountId, amountMicros, metadata } = amountAndAccount(event);
    return [
      {
        description: "Payment received",
        entryType: "invoice_payment",
        metadata,
        occurredAt: event.occurredAt,
        postings: [
          { accountCode: systemAccountCodes.psp, amountMicros, direction: "debit" },
          {
            accountCode: customerReceivableCode(accountId),
            amountMicros,
            direction: "credit",
          },
        ],
      },
    ];
  },
  name: "payment_received",
  version: 1,
};

export const paymentRefundedRule: PostingRule = {
  build(event: FinancialEventRecord): EntryDraft[] {
    const { accountId, amountMicros, metadata } = amountAndAccount(event);
    const earnedMicros = parseMicros(event.payload["earnedMicros"] ?? 0, "earnedMicros");
    if (earnedMicros < 0n || earnedMicros > amountMicros) {
      throw new LedgerError(
        "invalid_amount",
        "The earned part of a refund cannot exceed the refund",
      );
    }
    const entries: EntryDraft[] = [
      {
        description: "Payment refunded",
        entryType: "payment_refund",
        metadata,
        occurredAt: event.occurredAt,
        postings: [
          {
            accountCode: customerReceivableCode(accountId),
            amountMicros,
            direction: "debit",
          },
          { accountCode: systemAccountCodes.psp, amountMicros, direction: "credit" },
        ],
      },
    ];
    if (earnedMicros > 0n) {
      entries.push({
        description: "Earned subscription revenue refunded",
        entryType: "revenue_refund",
        metadata,
        occurredAt: event.occurredAt,
        postings: [
          {
            accountCode: systemAccountCodes.revenueSubscriptions,
            amountMicros: earnedMicros,
            direction: "debit",
          },
          {
            accountCode: customerReceivableCode(accountId),
            amountMicros: earnedMicros,
            direction: "credit",
          },
        ],
      });
    }
    return entries;
  },
  name: "payment_refunded",
  version: 1,
};

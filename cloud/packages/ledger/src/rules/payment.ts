import { customerReceivableCode, systemAccountCodes } from "../chart";
import { parseMicros } from "../money";
import {
  LedgerError,
  type EntryDraft,
  type FinancialEventRecord,
  type PostingRule,
} from "../types";

// Money through the payment provider (§3.2, cloud/docs/billing.md).
//
//   'payment.received'   the provider collected what the customer owed
//     Dr asset:psp:main
//     Cr asset:receivable:customer:<id>
//   and, when the provider is not a merchant of record and the tax it
//   collected is ours to remit (`taxMicros` in the payload),
//     Dr asset:psp:main
//     Cr liability:sales_tax
//
//   'payment.refunded'   the provider handed money back
//     Dr asset:receivable:customer:<id>
//     Cr asset:psp:main
//   for the part of it we had already earned,
//     Dr revenue:subscriptions
//     Cr asset:receivable:customer:<id>
//   and for the tax it hands back with it (`taxMicros`),
//     Dr liability:sales_tax
//     Cr asset:psp:main
//
//   'payment.fee'   the provider kept its processing fee
//     Dr expense:psp_fees
//     Cr asset:psp:main
//
// `amountMicros` is always net of tax: the receivable and revenue never see
// the tax, which was never ours to earn. A merchant of record (Creem) keeps
// the tax and sends no `taxMicros`; Stripe leaves it in our balance, and it
// sits on liability:sales_tax until it is paid to the tax authority.
//
// The unearned part of a refund comes out of the deferral through the
// subscription refund recipe, which credits the receivable; the cash leg
// here debits it again, so a refund leaves the customer owing nothing.

export const paymentReceivedEventType = "payment.received";
export const paymentRefundedEventType = "payment.refunded";
export const paymentFeeEventType = "payment.fee";

function amountAndAccount(event: FinancialEventRecord): {
  accountId: string;
  amountMicros: bigint;
  metadata: Record<string, unknown>;
  taxMicros: bigint;
} {
  const amountMicros = parseMicros(event.payload["amountMicros"] ?? 0, "amountMicros");
  if (amountMicros <= 0n) {
    throw new LedgerError("invalid_amount", "A payment entry must move a positive amount");
  }
  const taxMicros = parseMicros(event.payload["taxMicros"] ?? 0, "taxMicros");
  if (taxMicros < 0n) {
    throw new LedgerError("invalid_amount", "Tax on a payment cannot be negative");
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
      ...pick("feeRef"),
      ...pick("paymentRef"),
      ...pick("periodId"),
      ...pick("planCode"),
      ...pick("provider"),
      ...pick("refundRef"),
      ...pick("settlement"),
    },
    taxMicros,
  };
}

function taxEntry(
  event: FinancialEventRecord,
  metadata: Record<string, unknown>,
  taxMicros: bigint,
  direction: "collected" | "returned",
): EntryDraft {
  const collected = direction === "collected";
  return {
    description: collected ? "Sales tax collected" : "Sales tax refunded",
    entryType: collected ? "sales_tax_collected" : "sales_tax_refunded",
    metadata,
    occurredAt: event.occurredAt,
    postings: [
      {
        accountCode: systemAccountCodes.psp,
        amountMicros: taxMicros,
        direction: collected ? "debit" : "credit",
      },
      {
        accountCode: systemAccountCodes.salesTax,
        amountMicros: taxMicros,
        direction: collected ? "credit" : "debit",
      },
    ],
  };
}

export const paymentReceivedRule: PostingRule = {
  build(event: FinancialEventRecord): EntryDraft[] {
    const { accountId, amountMicros, metadata, taxMicros } = amountAndAccount(event);
    const entries: EntryDraft[] = [
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
    if (taxMicros > 0n) {
      entries.push(taxEntry(event, metadata, taxMicros, "collected"));
    }
    return entries;
  },
  name: "payment_received",
  // v2 (migration 0075): the tax a provider leaves with us is booked.
  version: 2,
};

export const paymentRefundedRule: PostingRule = {
  build(event: FinancialEventRecord): EntryDraft[] {
    const { accountId, amountMicros, metadata, taxMicros } = amountAndAccount(event);
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
    if (taxMicros > 0n) {
      entries.push(taxEntry(event, metadata, taxMicros, "returned"));
    }
    return entries;
  },
  name: "payment_refunded",
  // v2 (migration 0075): the tax handed back with a refund is booked.
  version: 2,
};

// The provider's fee for moving a payment (or for a dispute). It never
// touches the customer's receivable: the customer paid the price, and the
// fee is what collecting it cost us. The event still names the account, so
// a customer's margin can count it.
export const paymentFeeRule: PostingRule = {
  build(event: FinancialEventRecord): EntryDraft[] {
    const { amountMicros, metadata } = amountAndAccount(event);
    return [
      {
        description: "Payment provider fee",
        entryType: "psp_fee",
        metadata,
        occurredAt: event.occurredAt,
        postings: [
          { accountCode: systemAccountCodes.pspFees, amountMicros, direction: "debit" },
          { accountCode: systemAccountCodes.psp, amountMicros, direction: "credit" },
        ],
      },
    ];
  },
  name: "payment_fee",
  version: 1,
};

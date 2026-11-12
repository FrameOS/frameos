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
//   'payment.received'   the provider collected what the customer owed.
//   When the provider is not a merchant of record and the tax it collected
//   is ours to remit (`taxMicros` in the payload), the tax is charged to the
//   customer first, as their invoice charged it,
//     Dr asset:receivable:customer:<id>     tax
//     Cr liability:sales_tax                tax
//   then the payment, tax included, settles the receivable:
//     Dr asset:psp:main                     amount + tax
//     Cr asset:receivable:customer:<id>     amount + tax
//
//   'payment.refunded'   the provider handed money back, tax included
//     Dr asset:receivable:customer:<id>     amount + tax
//     Cr asset:psp:main                     amount + tax
//   the tax in it comes back off the customer's account (`taxMicros`),
//     Dr liability:sales_tax                tax
//     Cr asset:receivable:customer:<id>     tax
//   and for the part of it we had already earned,
//     Dr revenue:subscriptions
//     Cr asset:receivable:customer:<id>
//
//   'payment.fee'   the provider kept its processing fee
//     Dr expense:psp_fees
//     Cr asset:psp:main
//
// `amountMicros` is always net of tax, and revenue never sees the tax, which
// was never ours to earn. The receivable does since v3 (2026-11-07): the
// customer's statement then reads like their invoice (the plan, the VAT,
// the payment of both) instead of a payment smaller than the card charge.
// The balances are the same as v2's, which sent the tax from the provider
// balance straight to liability:sales_tax. A merchant of record (Creem)
// keeps the tax and sends no `taxMicros`; Stripe leaves it in our balance,
// and it sits on liability:sales_tax until it is paid to the tax authority.
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

// The tax on the customer's account: charged with a payment, taken off
// again with a refund. "VAT or sales tax" because the customer reads it.
function taxEntry(
  event: FinancialEventRecord,
  accountId: string,
  metadata: Record<string, unknown>,
  taxMicros: bigint,
  direction: "charged" | "returned",
): EntryDraft {
  const charged = direction === "charged";
  return {
    description: charged ? "VAT or sales tax" : "VAT or sales tax refunded",
    entryType: charged ? "sales_tax_charged" : "sales_tax_refunded",
    metadata,
    occurredAt: event.occurredAt,
    postings: [
      {
        accountCode: customerReceivableCode(accountId),
        amountMicros: taxMicros,
        direction: charged ? "debit" : "credit",
      },
      {
        accountCode: systemAccountCodes.salesTax,
        amountMicros: taxMicros,
        direction: charged ? "credit" : "debit",
      },
    ],
  };
}

export const paymentReceivedRule: PostingRule = {
  build(event: FinancialEventRecord): EntryDraft[] {
    const { accountId, amountMicros, metadata, taxMicros } = amountAndAccount(event);
    const paidMicros = amountMicros + taxMicros;
    return [
      ...(taxMicros > 0n ? [taxEntry(event, accountId, metadata, taxMicros, "charged")] : []),
      {
        description: "Payment received",
        entryType: "invoice_payment",
        metadata,
        occurredAt: event.occurredAt,
        postings: [
          { accountCode: systemAccountCodes.psp, amountMicros: paidMicros, direction: "debit" },
          {
            accountCode: customerReceivableCode(accountId),
            amountMicros: paidMicros,
            direction: "credit",
          },
        ],
      },
    ];
  },
  name: "payment_received",
  // v2 (migration 0075): the tax a provider leaves with us is booked.
  // v3: through the customer's receivable, so their statement shows it.
  version: 3,
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
    const refundedMicros = amountMicros + taxMicros;
    const entries: EntryDraft[] = [
      {
        description: "Payment refunded",
        entryType: "payment_refund",
        metadata,
        occurredAt: event.occurredAt,
        postings: [
          {
            accountCode: customerReceivableCode(accountId),
            amountMicros: refundedMicros,
            direction: "debit",
          },
          { accountCode: systemAccountCodes.psp, amountMicros: refundedMicros, direction: "credit" },
        ],
      },
    ];
    if (taxMicros > 0n) {
      entries.push(taxEntry(event, accountId, metadata, taxMicros, "returned"));
    }
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
  // v2 (migration 0075): the tax handed back with a refund is booked.
  // v3: through the customer's receivable, like the payment's.
  version: 3,
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

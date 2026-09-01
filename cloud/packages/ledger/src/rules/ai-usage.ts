import { customerReceivableCode, systemAccountCodes } from "../chart";
import { parseMicros } from "../money";
import {
  LedgerError,
  type EntryDraft,
  type FinancialEventRecord,
  type PostingRule,
} from "../types";

// One metered AI turn, as accounting. The PAYG core (§3.2).
//
// Two *independent* balanced entries come out of the one fact, and keeping
// them independent is the point: what the customer owes us and what we owe
// the provider are different amounts, settled on different days, against
// different counterparties. The margin is never posted — it is the
// difference between these two entries, which is what makes it impossible
// for a stored margin to drift away from the revenue and cost it claims to
// sit between.
//
//   Entry 'ai_usage_charge'   (only when the turn is billable)
//     Dr asset:receivable:customer:<id>      the price
//     Cr revenue:ai_usage                    the price
//
//   Entry 'ai_usage_cost'     (only when the key was ours)
//     Dr expense:cogs:openai                 the provider cost
//     Cr liability:accrued:openai            the provider cost
//
// Revenue is recognized immediately rather than deferred: for metered usage
// the service is rendered at the moment it is used, which is what makes PAYG
// accounting simple in a way subscriptions are not. The accrued liability is
// cleared when the provider's invoice is actually paid, and the gap between
// our accrual and their invoice is exactly what reconciliation measures.
//
// **Version 2** (2026-09-01) moved the customer leg from a prepaid liability
// to a receivable, which is the whole of what §0's postpay decision cost the
// posting rules. Nobody pre-pays; usage accrues as money owed and one invoice
// a month collects it, so the charge debits an asset (what they owe us)
// rather than drawing down a balance they handed us in advance. Everything
// else — the cost entry, the metadata, the independence of the two entries —
// is untouched, and v1 stays readable above because a version bump is a
// promise that old entries still mean what they said.
//
// A turn on the customer's own key produces neither entry, which means it
// produces no event at all — the kernel refuses a rule that builds nothing,
// and metering.ts is where that decision is made, before an event exists.
export const aiUsageEventType = "ai_usage.turn";

export const aiUsageRule: PostingRule = {
  build(event: FinancialEventRecord): EntryDraft[] {
    const payload = event.payload;
    const costMicros = parseMicros(payload["costMicros"] ?? 0, "costMicros");
    const priceMicros = parseMicros(payload["priceMicros"] ?? 0, "priceMicros");
    if (costMicros < 0n || priceMicros < 0n) {
      throw new LedgerError(
        "invalid_amount",
        "A metered turn cannot cost or be priced at a negative amount",
      );
    }

    const model = typeof payload["model"] === "string" ? payload["model"] : "unknown";
    const metadata = entryMetadata(event);
    const entries: EntryDraft[] = [];

    if (priceMicros > 0n) {
      // The account is on the event, not in the payload: it is the column the
      // ledger indexes and the one thing that survives the customer's
      // deletion. A priced turn with nobody to charge is a bug, not a
      // system-level fact.
      if (!event.accountId) {
        throw new LedgerError(
          "invalid_draft",
          "A billable turn must name the account it is billed to",
        );
      }
      entries.push({
        description: `AI usage on ${model}`,
        entryType: "ai_usage_charge",
        metadata,
        occurredAt: event.occurredAt,
        postings: [
          {
            accountCode: customerReceivableCode(event.accountId),
            amountMicros: priceMicros,
            direction: "debit",
          },
          {
            accountCode: systemAccountCodes.revenueAiUsage,
            amountMicros: priceMicros,
            direction: "credit",
          },
        ],
      });
    }

    if (costMicros > 0n) {
      entries.push({
        description: `Provider cost for AI usage on ${model}`,
        entryType: "ai_usage_cost",
        metadata,
        occurredAt: event.occurredAt,
        postings: [
          {
            accountCode: systemAccountCodes.cogsOpenai,
            amountMicros: costMicros,
            direction: "debit",
          },
          {
            accountCode: systemAccountCodes.accruedOpenai,
            amountMicros: costMicros,
            direction: "credit",
          },
        ],
      });
    }

    if (entries.length === 0) {
      throw new LedgerError(
        "invalid_draft",
        "A metered turn that cost nothing and is priced at nothing has no entries to post",
      );
    }
    return entries;
  },
  name: "ai_usage",
  version: 2,
};

// The pricing snapshot, copied onto both entries: token counts, the unit
// prices in force, the margin. An entry has to stay explainable after the
// price table and the margin setting have both moved on.
function entryMetadata(event: FinancialEventRecord): Record<string, unknown> {
  const payload = event.payload;
  const pick = (key: string) => (payload[key] === undefined ? {} : { [key]: payload[key] });
  return {
    ...pick("credentialSource"),
    ...pick("model"),
    ...pick("pricing"),
    ...pick("rounds"),
    ...pick("surface"),
    ...pick("tokens"),
    ...pick("usageRecordId"),
    costMicros: String(payload["costMicros"] ?? 0),
    priceMicros: String(payload["priceMicros"] ?? 0),
  };
}

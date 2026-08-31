import { parseMicros } from "../money";
import {
  LedgerError,
  type EntryDraft,
  type FinancialEventRecord,
  type PostingDirection,
  type PostingRule,
} from "../types";

// The escape hatch, and the first rule the ledger ever needs: a superadmin
// states the legs and the kernel posts them. Everything an automated recipe
// cannot express — an opening balance, a correction nobody wrote a rule for,
// a provider invoice settled by hand — goes through here rather than through
// someone writing postings directly, so it is still an event, still
// idempotent, still reversible.
export const manualJournalEventType = "manual_journal.posted";

interface ManualJournalLeg {
  accountCode?: unknown;
  amountMicros?: unknown;
  currency?: unknown;
  direction?: unknown;
}

export const manualJournalRule: PostingRule = {
  build(event: FinancialEventRecord): EntryDraft[] {
    const payload = event.payload;
    const description = payload["description"];
    if (typeof description !== "string" || description.trim() === "") {
      throw new LedgerError(
        "invalid_draft",
        "A manual journal needs a description saying why it was posted",
      );
    }

    const legs = payload["legs"];
    if (!Array.isArray(legs) || legs.length < 2) {
      throw new LedgerError(
        "invalid_draft",
        "A manual journal needs at least two legs",
      );
    }

    const externalRef = payload["externalRef"];
    const metadata = payload["metadata"];

    return [
      {
        description: description.trim(),
        entryType: "manual_journal",
        ...(typeof externalRef === "string" ? { externalRef } : {}),
        ...(isRecord(metadata) ? { metadata } : {}),
        occurredAt: event.occurredAt,
        postings: legs.map((leg, index) => readLeg(leg, index)),
      },
    ];
  },
  name: "manual_journal",
  version: 1,
};

function readLeg(value: unknown, index: number) {
  if (!isRecord(value)) {
    throw new LedgerError("invalid_draft", `Leg ${index} is not an object`);
  }
  const leg = value as ManualJournalLeg;
  if (typeof leg.accountCode !== "string") {
    throw new LedgerError("invalid_draft", `Leg ${index} has no accountCode`);
  }
  if (leg.direction !== "debit" && leg.direction !== "credit") {
    throw new LedgerError(
      "invalid_draft",
      `Leg ${index} must be a debit or a credit`,
    );
  }
  return {
    accountCode: leg.accountCode,
    amountMicros: parseMicros(leg.amountMicros, `Leg ${index} amountMicros`),
    ...(typeof leg.currency === "string" ? { currency: leg.currency } : {}),
    direction: leg.direction as PostingDirection,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

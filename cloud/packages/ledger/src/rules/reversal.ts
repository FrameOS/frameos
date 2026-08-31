import {
  LedgerError,
  type EntryDraft,
  type FinancialEventRecord,
  type PostingRule,
  type RuleContext,
} from "../types";

// The only way to undo anything. Nothing in the journal is ever edited or
// deleted — a wrong entry is reversed leg for leg and, if something correct
// belongs in its place, rebooked as a fresh entry. Reverse-and-rebook rather
// than deltas: deltas are cheaper to write and compound into books nobody
// can audit.
export const reversalEventType = "ledger_entry.reversed";

export const reversalRule: PostingRule = {
  async build(
    event: FinancialEventRecord,
    context: RuleContext,
  ): Promise<EntryDraft[]> {
    const entryId = event.payload["entryId"];
    if (typeof entryId !== "string") {
      throw new LedgerError(
        "invalid_draft",
        "A reversal needs the entryId it reverses",
      );
    }
    const reason = event.payload["reason"];
    if (typeof reason !== "string" || reason.trim() === "") {
      throw new LedgerError(
        "invalid_draft",
        "A reversal needs a reason: the books have to say why",
      );
    }

    const original = await context.loadEntry(entryId);
    if (!original) {
      throw new LedgerError(
        "entry_not_found",
        `Ledger entry ${entryId} does not exist`,
      );
    }

    // The unique index on reverses_entry_id would refuse the second one
    // anyway; catching it here says why instead of surfacing a constraint.
    const existing = await context.findReversal(entryId);
    if (existing) {
      throw new LedgerError(
        "already_reversed",
        `Ledger entry ${entryId} was already reversed by ${existing.id}`,
      );
    }

    return [
      {
        description: `Reversal: ${original.description}`,
        entryType: `${original.entryType}_reversal`,
        metadata: {
          reason: reason.trim(),
          reversedEntryType: original.entryType,
          // The reversal is posted today; the entry it undoes belongs to the
          // period it was posted in, and the difference is worth keeping.
          reversedOccurredAt: original.occurredAt.toISOString(),
        },
        occurredAt: event.occurredAt,
        // Every leg mirrored, nothing else touched. The integrity check
        // proves the mirror holds for every reversal in the book.
        postings: original.postings.map((posting) => ({
          accountCode: posting.accountCode,
          amountMicros: posting.amountMicros,
          currency: posting.currency,
          direction: posting.direction === "debit" ? "credit" : "debit",
        })),
        reversesEntryId: original.id,
      } satisfies EntryDraft,
    ];
  },
  name: "reversal",
  version: 1,
};

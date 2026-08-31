import { parseMicros } from "../money";
import {
  LedgerError,
  type EntryDraft,
  type FinancialEventRecord,
  type PostingRule,
  type RuleContext,
} from "../types";

// Moving an amount from one account to another — the *second* of the two
// mechanisms in §1.3, and the one with real accounting weight.
//
// The first mechanism is re-pointing an account at a different reporting
// group: mutable, instant, and it touches no posting. Use that when the
// question is "which bucket should this account show up under". Use this
// when the question is "this amount is sitting in the wrong account" — a
// revenue line booked as AI usage that was really a subscription, say. The
// original entry is never touched; this posts a fresh balanced entry beside
// it and links back through `metadata.reclassifies`.
//
// Deliberately NOT `reverses_entry_id`. That column means "these two entries
// cancel out leg for leg", which the integrity checker proves for every row
// that has it — and a reclassification is not a cancellation, it moves one
// amount between two accounts and leaves the rest of the original alone.
// Reusing the column would make the check fail on a correct entry.
export const reclassificationEventType = "ledger_entry.reclassified";

export const reclassificationRule: PostingRule = {
  async build(
    event: FinancialEventRecord,
    context: RuleContext,
  ): Promise<EntryDraft[]> {
    const payload = event.payload;
    const debitAccountCode = payload["debitAccountCode"];
    const creditAccountCode = payload["creditAccountCode"];
    if (
      typeof debitAccountCode !== "string" ||
      typeof creditAccountCode !== "string"
    ) {
      throw new LedgerError(
        "invalid_draft",
        "A reclassification needs the account to debit and the account to credit",
      );
    }
    if (debitAccountCode === creditAccountCode) {
      throw new LedgerError(
        "invalid_draft",
        "A reclassification between one account and itself moves nothing",
      );
    }
    const reason = payload["reason"];
    if (typeof reason !== "string" || reason.trim() === "") {
      throw new LedgerError(
        "invalid_draft",
        "A reclassification needs a reason: the books have to say why an amount moved",
      );
    }
    const amountMicros = parseMicros(payload["amountMicros"], "amountMicros");
    if (amountMicros <= 0n) {
      throw new LedgerError(
        "invalid_amount",
        "A reclassification must move a positive amount",
      );
    }

    // The entry it is about, when one is named. Optional: an amount can be
    // in the wrong account without one entry being to blame for it, and a
    // reclass with no origin is still a reclass. But a named entry that does
    // not exist is a typo worth refusing.
    const reclassifies = payload["reclassifiesEntryId"];
    if (reclassifies !== undefined && typeof reclassifies !== "string") {
      throw new LedgerError(
        "invalid_draft",
        "reclassifiesEntryId must be a ledger entry id",
      );
    }
    if (typeof reclassifies === "string") {
      const original = await context.loadEntry(reclassifies);
      if (!original) {
        throw new LedgerError(
          "entry_not_found",
          `Ledger entry ${reclassifies} does not exist`,
        );
      }
    }

    const currency = payload["currency"];
    const leg = (accountCode: string, direction: "credit" | "debit") => ({
      accountCode,
      amountMicros,
      ...(typeof currency === "string" ? { currency } : {}),
      direction,
    });

    return [
      {
        description: `Reclassification: ${reason.trim()}`,
        entryType: "reclassification",
        metadata: {
          reason: reason.trim(),
          ...(typeof reclassifies === "string" ? { reclassifies } : {}),
        },
        occurredAt: event.occurredAt,
        postings: [
          leg(debitAccountCode, "debit"),
          leg(creditAccountCode, "credit"),
        ],
      },
    ];
  },
  name: "reclassification",
  version: 1,
};

import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import {
  financialEvents,
  ledgerAccounts,
  ledgerBalances,
  ledgerEntries,
  ledgerPostings,
} from "@frameos-cloud/db";
import { ensureLedgerAccount } from "./chart";
import { postingRules } from "./rules";
import {
  LedgerError,
  type EntryDraft,
  type FinancialEventInput,
  type FinancialEventRecord,
  type LedgerDb,
  type LedgerExecutor,
  type LedgerTx,
  type PostEventResult,
  type PostedEntry,
  type PostingDirection,
  type PostingRule,
  type PostingRuleRegistry,
  type RuleContext,
} from "./types";

export interface PostEventOptions {
  // Phase 2 and 3 hand in their own recipes; tests hand in fakes. Default is
  // every rule the package ships.
  rules?: PostingRuleRegistry | undefined;
}

// The posting kernel: the one and only writer of journal entries.
//
// Product code never inserts a posting. It states a fact — "this turn burned
// these tokens", "Stripe says $10 arrived" — and this turns the fact into
// balanced double entries through a versioned rule. Everything below happens
// in one transaction, so an event either exists with its full set of entries
// or does not exist at all; there is no state where the books are half
// written.
//
// Replay is a no-op, not a second charge: the event's idempotency key is
// unique, and a call that loses that race reads back the entries the winner
// posted. That is what makes an at-least-once caller (a Stripe webhook
// retry, the unposted-usage sweep) exactly-once in the ledger.
export async function postEvent(
  db: LedgerExecutor,
  input: FinancialEventInput,
  options: PostEventOptions = {},
): Promise<PostEventResult> {
  const rules = options.rules ?? postingRules;
  const occurredAt = input.occurredAt ?? new Date();

  return (db as LedgerDb).transaction(async (tx) => {
    const [inserted] = await tx
      .insert(financialEvents)
      .values({
        accountId: input.accountId ?? null,
        eventType: input.eventType,
        idempotencyKey: input.idempotencyKey,
        occurredAt,
        payload: input.payload ?? {},
        source: input.source,
        sourceRef: input.sourceRef ?? null,
      })
      .onConflictDoNothing({ target: financialEvents.idempotencyKey })
      .returning();

    let event = inserted ? toEventRecord(inserted) : undefined;

    if (!event) {
      const [existing] = await tx
        .select()
        .from(financialEvents)
        .where(eq(financialEvents.idempotencyKey, input.idempotencyKey))
        .limit(1);
      if (!existing) {
        throw new LedgerError(
          "event_conflict",
          `Event ${input.idempotencyKey} could not be inserted or read back`,
        );
      }
      event = toEventRecord(existing);

      // One key, one fact. A key reused for a different kind of event is a
      // caller bug that would otherwise hide a missed posting behind a
      // successful-looking replay.
      if (event.eventType !== input.eventType) {
        throw new LedgerError(
          "event_conflict",
          `Idempotency key ${input.idempotencyKey} already belongs to a ${event.eventType} event`,
        );
      }

      if (event.processedAt) {
        return {
          entries: await loadEntriesForEvent(tx, event.id),
          event,
          replayed: true,
        };
      }
      // An event row with no postings is the sweep's territory: an earlier
      // attempt inserted it in a transaction that later failed to post. Fall
      // through and post it now.
    }

    const rule = rules[event.eventType];
    if (!rule) {
      throw new LedgerError(
        "no_posting_rule",
        `No posting rule is registered for event type ${event.eventType}`,
      );
    }

    const drafts = await rule.build(event, ruleContext(tx));
    validateDrafts(drafts, rule);

    const entries: PostedEntry[] = [];
    const balanceDeltas = new Map<string, bigint>();

    for (const draft of drafts) {
      const [entryRow] = await tx
        .insert(ledgerEntries)
        .values({
          description: draft.description,
          entryType: draft.entryType,
          eventId: event.id,
          externalRef: draft.externalRef ?? null,
          metadata: draft.metadata ?? {},
          occurredAt: draft.occurredAt ?? event.occurredAt,
          reversesEntryId: draft.reversesEntryId ?? null,
          ruleVersion: rule.version,
        })
        .returning({ id: ledgerEntries.id, occurredAt: ledgerEntries.occurredAt });
      if (!entryRow) {
        throw new LedgerError(
          "invalid_draft",
          `Failed to insert ${draft.entryType} entry`,
        );
      }

      const resolved = [];
      for (const posting of draft.postings) {
        const account = await ensureLedgerAccount(tx, posting.accountCode);
        const currency = posting.currency ?? account.currency;
        if (currency !== account.currency) {
          throw new LedgerError(
            "currency_mismatch",
            `${posting.accountCode} is a ${account.currency} account; the posting is in ${currency}`,
          );
        }
        resolved.push({ account, currency, posting });
        const delta =
          posting.direction === account.normalSide
            ? posting.amountMicros
            : -posting.amountMicros;
        balanceDeltas.set(
          account.id,
          (balanceDeltas.get(account.id) ?? 0n) + delta,
        );
      }

      await tx.insert(ledgerPostings).values(
        resolved.map(({ account, currency, posting }) => ({
          amountMicros: posting.amountMicros,
          currency,
          direction: posting.direction,
          entryId: entryRow.id,
          ledgerAccountId: account.id,
        })),
      );

      entries.push({
        description: draft.description,
        entryType: draft.entryType,
        externalRef: draft.externalRef ?? null,
        id: entryRow.id,
        metadata: draft.metadata ?? {},
        occurredAt: entryRow.occurredAt,
        // The account's own code, not the draft's spelling of it: the two
        // differ when a leg named a customer uuid in the wrong case.
        postings: resolved.map(({ account, currency, posting }) => ({
          accountCode: account.code,
          amountMicros: posting.amountMicros,
          currency,
          direction: posting.direction,
        })),
        reversesEntryId: draft.reversesEntryId ?? null,
        ruleVersion: rule.version,
      });
    }

    // Two transactions posting to one account (two customers' turns both
    // crediting revenue:ai_usage) contend on the same balance row. Always
    // take those rows in the same order so a pair of them queues instead of
    // deadlocking.
    for (const ledgerAccountId of [...balanceDeltas.keys()].sort()) {
      const delta = balanceDeltas.get(ledgerAccountId) ?? 0n;
      await tx
        .insert(ledgerBalances)
        .values({ balanceMicros: delta, ledgerAccountId })
        .onConflictDoUpdate({
          set: {
            balanceMicros: sql`${ledgerBalances.balanceMicros} + ${delta.toString()}::bigint`,
            updatedAt: new Date(),
          },
          target: ledgerBalances.ledgerAccountId,
        });
    }

    const processedAt = new Date();
    await tx
      .update(financialEvents)
      .set({ processedAt })
      .where(eq(financialEvents.id, event.id));

    return { entries, event: { ...event, processedAt }, replayed: false };
  });
}

// Reverses one entry: the convenience wrapper over the reversal rule, with
// the idempotency key that makes reversing the same entry twice a no-op
// instead of a second mirror.
export async function reverseEntry(
  db: LedgerExecutor,
  input: {
    accountId?: string | null | undefined;
    entryId: string;
    reason: string;
    source: string;
  },
  options: PostEventOptions = {},
): Promise<PostEventResult> {
  return postEvent(
    db,
    {
      accountId: input.accountId ?? null,
      eventType: "ledger_entry.reversed",
      idempotencyKey: `reversal:${input.entryId}`,
      payload: { entryId: input.entryId, reason: input.reason },
      source: input.source,
      sourceRef: input.entryId,
    },
    options,
  );
}

export function validateDrafts(drafts: EntryDraft[], rule: PostingRule): void {
  if (drafts.length === 0) {
    throw new LedgerError(
      "invalid_draft",
      `Rule ${rule.name} produced no entries`,
    );
  }

  const seenTypes = new Set<string>();
  for (const draft of drafts) {
    if (!draft.entryType.trim() || !draft.description.trim()) {
      throw new LedgerError(
        "invalid_draft",
        `Rule ${rule.name} produced an entry with no type or description`,
      );
    }
    if (!rule.allowsRepeatedEntryTypes && seenTypes.has(draft.entryType)) {
      throw new LedgerError(
        "invalid_draft",
        `Rule ${rule.name} posted ${draft.entryType} twice for one event`,
      );
    }
    seenTypes.add(draft.entryType);

    if (draft.postings.length < 2) {
      throw new LedgerError(
        "invalid_draft",
        `${draft.entryType} needs at least two postings`,
      );
    }

    // Balanced per currency, not just overall: an entry that debits ten
    // dollars and credits ten euros is not an entry.
    const sums = new Map<string, bigint>();
    for (const posting of draft.postings) {
      if (posting.amountMicros <= 0n) {
        throw new LedgerError(
          "invalid_amount",
          `${draft.entryType} has a posting of ${posting.amountMicros} micros; amounts are positive and the direction carries the sign`,
        );
      }
      const currency = posting.currency ?? "USD";
      const signed =
        posting.direction === "debit" ? posting.amountMicros : -posting.amountMicros;
      sums.set(currency, (sums.get(currency) ?? 0n) + signed);
    }
    for (const [currency, sum] of sums) {
      if (sum !== 0n) {
        throw new LedgerError(
          "entry_unbalanced",
          `${draft.entryType} is out of balance by ${sum} ${currency} micros`,
        );
      }
    }
  }
}

function ruleContext(tx: LedgerTx): RuleContext {
  return {
    async findReversal(entryId: string) {
      const [row] = await tx
        .select({ id: ledgerEntries.id })
        .from(ledgerEntries)
        .where(eq(ledgerEntries.reversesEntryId, entryId))
        .limit(1);
      return row ? await loadEntry(tx, row.id) : undefined;
    },
    async loadEntry(entryId: string) {
      return loadEntry(tx, entryId);
    },
  };
}

async function loadEntry(
  tx: LedgerTx,
  entryId: string,
): Promise<PostedEntry | undefined> {
  const [entries] = await loadEntries(tx, [entryId]);
  return entries;
}

async function loadEntriesForEvent(
  tx: LedgerTx,
  eventId: string,
): Promise<PostedEntry[]> {
  const rows = await tx
    .select({ id: ledgerEntries.id })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.eventId, eventId));
  return loadEntries(
    tx,
    rows.map((row) => row.id),
  );
}

async function loadEntries(
  tx: LedgerTx,
  entryIds: string[],
): Promise<PostedEntry[]> {
  if (entryIds.length === 0) {
    return [];
  }
  const headers = await tx
    .select()
    .from(ledgerEntries)
    .where(inArray(ledgerEntries.id, entryIds));
  const postings = await tx
    .select({
      accountCode: ledgerAccounts.code,
      amountMicros: ledgerPostings.amountMicros,
      currency: ledgerPostings.currency,
      direction: ledgerPostings.direction,
      entryId: ledgerPostings.entryId,
      id: ledgerPostings.id,
    })
    .from(ledgerPostings)
    .innerJoin(
      ledgerAccounts,
      eq(ledgerAccounts.id, ledgerPostings.ledgerAccountId),
    )
    .where(inArray(ledgerPostings.entryId, entryIds));

  return headers
    .map((header) => ({
      description: header.description,
      entryType: header.entryType,
      externalRef: header.externalRef,
      id: header.id,
      metadata: (header.metadata ?? {}) as Record<string, unknown>,
      occurredAt: header.occurredAt,
      postings: postings
        .filter((posting) => posting.entryId === header.id)
        .sort((a, b) => Number(a.id - b.id))
        .map((posting) => ({
          accountCode: posting.accountCode,
          amountMicros: posting.amountMicros,
          currency: posting.currency,
          direction: posting.direction as PostingDirection,
        })),
      reversesEntryId: header.reversesEntryId,
      ruleVersion: header.ruleVersion,
    }))
    .sort((a, b) => entryIds.indexOf(a.id) - entryIds.indexOf(b.id));
}

function toEventRecord(row: typeof financialEvents.$inferSelect): FinancialEventRecord {
  return {
    accountId: row.accountId,
    eventType: row.eventType,
    id: row.id,
    idempotencyKey: row.idempotencyKey,
    occurredAt: row.occurredAt,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    processedAt: row.processedAt,
    source: row.source,
    sourceRef: row.sourceRef,
  };
}

// Events whose postings never happened. A tripwire, not a queue: this
// kernel inserts the event and stamps `processed_at` in one transaction, so
// nothing it wrote can ever show up here — a row that does was written by
// something else, which is exactly what the nightly check wants to hear
// about. (The sweep's real queue is `ai_usage_records` with a null
// event_id; see metering.ts.)
export async function findUnpostedEvents(
  db: LedgerExecutor,
  olderThan: Date,
): Promise<FinancialEventRecord[]> {
  const rows = await db
    .select()
    .from(financialEvents)
    .where(
      and(
        isNull(financialEvents.processedAt),
        lt(financialEvents.createdAt, olderThan),
      ),
    );
  return rows.map(toEventRecord);
}

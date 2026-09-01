import type { createDb } from "@frameos-cloud/db";

// The kernel runs inside a transaction, and callers that already have one
// (a Stripe webhook writing its own rows) pass theirs in, so every function
// here takes whichever of the two it is handed.
export type LedgerDb = ReturnType<typeof createDb>;
export type LedgerTx = Parameters<Parameters<LedgerDb["transaction"]>[0]>[0];
export type LedgerExecutor = LedgerDb | LedgerTx;

export type LedgerAccountType =
  | "asset"
  | "liability"
  | "equity"
  | "revenue"
  | "contra_revenue"
  | "expense";

export type PostingDirection = "debit" | "credit";

export interface PostingDraft {
  accountCode: string;
  amountMicros: bigint;
  currency?: string | undefined;
  direction: PostingDirection;
}

// What a posting rule returns: one balanced journal entry, named by account
// code rather than id — rules never see the chart's primary keys.
export interface EntryDraft {
  description: string;
  entryType: string;
  externalRef?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
  occurredAt?: Date | undefined;
  postings: PostingDraft[];
  reversesEntryId?: string | undefined;
}

export interface FinancialEventInput {
  accountId?: string | null | undefined;
  eventType: string;
  // The dedupe handle. Replaying an event with the same key returns the
  // entries the first call posted instead of posting them twice.
  idempotencyKey: string;
  occurredAt?: Date | undefined;
  payload?: Record<string, unknown> | undefined;
  source: string;
  sourceRef?: string | null | undefined;
}

export interface FinancialEventRecord {
  accountId: string | null;
  eventType: string;
  id: string;
  idempotencyKey: string;
  occurredAt: Date;
  payload: Record<string, unknown>;
  processedAt: Date | null;
  source: string;
  sourceRef: string | null;
}

export interface PostedPosting {
  accountCode: string;
  amountMicros: bigint;
  currency: string;
  direction: PostingDirection;
}

export interface PostedEntry {
  description: string;
  entryType: string;
  externalRef: string | null;
  id: string;
  metadata: Record<string, unknown>;
  occurredAt: Date;
  postings: PostedPosting[];
  reversesEntryId: string | null;
  ruleVersion: number;
}

// What a rule may read while building. Everything a rule needs from the
// database arrives through here, which is what keeps rules testable without
// one: the reversal rule reads the entry it mirrors, and nothing else does.
export interface RuleContext {
  findReversal(entryId: string): Promise<PostedEntry | undefined>;
  loadEntry(entryId: string): Promise<PostedEntry | undefined>;
}

export interface PostingRule {
  // Distinct entry types are the norm — one event posting both
  // 'ai_usage_charge' and 'ai_usage_cost' is two types, not a repeat. A rule
  // that genuinely posts several entries of one type says so here, and the
  // integrity check stops treating it as a double-post.
  allowsRepeatedEntryTypes?: boolean;
  build(
    event: FinancialEventRecord,
    context: RuleContext,
  ): EntryDraft[] | Promise<EntryDraft[]>;
  name: string;
  // Bumped on any change to what the rule produces. Entries keep the version
  // they were posted under, so history stays readable after a rule changes.
  version: number;
}

export type PostingRuleRegistry = Readonly<Record<string, PostingRule>>;

export interface PostEventResult {
  entries: PostedEntry[];
  event: FinancialEventRecord;
  // True when this call found the event already posted and did nothing.
  replayed: boolean;
}

export type LedgerErrorCode =
  | "entry_unbalanced"
  | "event_conflict"
  | "invalid_amount"
  | "invalid_draft"
  | "no_posting_rule"
  | "unknown_account_code"
  | "currency_mismatch"
  | "entry_not_found"
  | "already_reversed";

export class LedgerError extends Error {
  readonly code: LedgerErrorCode;

  constructor(code: LedgerErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "LedgerError";
  }
}

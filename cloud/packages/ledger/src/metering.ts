import { and, asc, eq, isNull, lt, sql } from "drizzle-orm";
import { aiUsageRecords } from "@frameos-cloud/db";
import { postEvent, type PostEventOptions } from "./kernel";
import {
  priceUsage,
  resolveModelPrice,
  splitProviderUsage,
  type TokenUsage,
} from "./pricing";
import { aiUsageEventType } from "./rules/ai-usage";
import { readBillingSettings, type MeteringMode } from "./settings";
import type { LedgerExecutor, PostedEntry } from "./types";

// Metering: the bridge between "a chat turn finished" and the ledger.
//
// The order of operations here is the whole design, and it is deliberately
// not the obvious one. The usage record is written and committed FIRST, on
// its own; only then is the ledger event posted. If the post fails — the
// database blipped, a rule threw, the process died between the two — the
// record survives with `event_id` NULL and the nightly sweep re-posts it.
// Posting is keyed on the turn id, so the sweep is a replay rather than a
// second charge: at-least-once delivery, exactly-once effect.
//
// The tempting alternative, one transaction around both, has the failure
// mode that matters: a ledger hiccup would roll back the measurement too,
// and the turn would then be invisible — unbilled AND uncounted, with
// nothing left anywhere to notice it by.

export type CredentialSource = "account" | "platform" | "shared";

export interface AiUsageInput {
  // The customer, when there is one. Anonymous surfaces (the public scene
  // converter on the platform key) legitimately have none.
  accountId?: string | null | undefined;
  chatId?: string | null | undefined;
  credentialSource: CredentialSource;
  model: string;
  // When the tokens were burned, not when this ran. Drives which price row
  // applies and which period the revenue lands in.
  occurredAt?: Date | undefined;
  rounds?: number | undefined;
  // Which product surface spent the tokens: "scene_chat", "app_chat",
  // "scene_convert", "store_classify", ...
  surface?: string | null | undefined;
  // The turn's id, and the idempotency handle. One row per turn, forever.
  turnId: string;
  // As the provider reported it: `inputTokens` still INCLUDING the cached
  // ones. splitProviderUsage does the separating.
  usage: {
    cachedInputTokens?: number | undefined;
    inputTokens?: number | undefined;
    outputTokens?: number | undefined;
    reasoningTokens?: number | undefined;
  };
}

export interface AiUsageRecord {
  accountId: string | null;
  costMicros: bigint;
  currency: string;
  eventId: string | null;
  id: string;
  meteringMode: MeteringMode;
  model: string;
  priceMicros: bigint;
  turnId: string;
  usage: TokenUsage;
}

export interface RecordAiUsageResult {
  // The entries the post produced, empty when nothing was posted.
  entries: PostedEntry[];
  // Set when the post failed; the record still exists and the sweep owns it.
  postError?: unknown;
  posted: boolean;
  record: AiUsageRecord;
  // True when this turn had already been metered and nothing was written.
  replayed: boolean;
}

export interface RecordAiUsageOptions extends PostEventOptions {
  env?: Record<string, string | undefined> | undefined;
  // Post inline (the default). The nightly sweep passes false when it only
  // wants the record written.
  post?: boolean | undefined;
}

// Who pays the provider decides both numbers. The customer's own key costs
// us nothing and is charged nothing — we still keep the record, because
// "how much AI is this account using" is a question worth answering whoever
// paid for it. The operator's shared key is a real cost we absorb: booked as
// COGS, billed to nobody. Only the platform key is billable, and Phase 3 is
// what starts returning it.
function billing(source: CredentialSource): { billable: boolean; ours: boolean } {
  return {
    billable: source === "platform",
    ours: source === "platform" || source === "shared",
  };
}

export async function recordAiUsage(
  db: LedgerExecutor,
  input: AiUsageInput,
  options: RecordAiUsageOptions = {},
): Promise<RecordAiUsageResult> {
  const occurredAt = input.occurredAt ?? new Date();
  const settings = await readBillingSettings(db, options.env);
  const { billable, ours } = billing(input.credentialSource);
  const usage = splitProviderUsage(input.usage);
  const price = await resolveModelPrice(db, input.model, occurredAt);
  const priced = priceUsage({
    billable,
    marginBasisPoints: settings.marginBasisPoints,
    price,
    usage,
  });
  // A turn on someone else's key costs us nothing, whatever it burned.
  const costMicros = ours ? priced.costMicros : 0n;
  const priceMicros = billable ? priced.priceMicros : 0n;

  const [inserted] = await db
    .insert(aiUsageRecords)
    .values({
      accountId: input.accountId ?? null,
      cachedInputTokens: usage.cachedInputTokens,
      chatId: input.chatId ?? null,
      costMicros,
      credentialSource: input.credentialSource,
      currency: priced.currency,
      inputTokens: usage.inputTokens,
      meteringMode: settings.meteringMode,
      model: input.model,
      occurredAt,
      outputTokens: usage.outputTokens,
      priceMicros,
      pricing: priced.snapshot,
      reasoningTokens: usage.reasoningTokens,
      rounds: input.rounds ?? 0,
      surface: input.surface ?? null,
      turnId: input.turnId,
    })
    .onConflictDoNothing({ target: aiUsageRecords.turnId })
    .returning();

  if (!inserted) {
    // The turn was already metered: a retried onFinish, a resumed turn that
    // finished twice. Return what is on record rather than a second row.
    const existing = await loadRecordByTurn(db, input.turnId);
    return {
      entries: [],
      // Boolean(), not `!== null`: an existing row this call could not read
      // back has no event id to report either.
      posted: Boolean(existing?.eventId),
      record: existing ?? emptyRecord(input.turnId, priced.currency),
      replayed: true,
    };
  }

  const record = toRecord(inserted);
  if (options.post === false || !shouldPost(record)) {
    return { entries: [], posted: false, record, replayed: false };
  }

  try {
    const { entries, eventId } = await postUsageRecord(db, inserted, options);
    return { entries, posted: true, record: { ...record, eventId }, replayed: false };
  } catch (error) {
    // The measurement stands; the books catch up on the next sweep.
    return { entries: [], postError: error, posted: false, record, replayed: false };
  }
}

// Whether this record belongs in the journal at all: live mode, and money
// actually moved. Shadow rows and own-key turns are measurement, not
// accounting, and the sweep must leave both alone forever.
function shouldPost(record: {
  costMicros: bigint;
  meteringMode: string;
  priceMicros: bigint;
}): boolean {
  return (
    record.meteringMode === "live" &&
    (record.costMicros > 0n || record.priceMicros > 0n)
  );
}

type UsageRow = typeof aiUsageRecords.$inferSelect;

// Post one record's entries and stamp the event back onto it. Idempotent
// twice over: the kernel replays on the turn key, and the stamp is a plain
// update that a second run repeats harmlessly.
export async function postUsageRecord(
  db: LedgerExecutor,
  row: UsageRow,
  options: PostEventOptions = {},
): Promise<{ entries: PostedEntry[]; eventId: string }> {
  const result = await postEvent(
    db,
    {
      accountId: row.accountId,
      eventType: aiUsageEventType,
      idempotencyKey: `turn:${row.turnId}`,
      occurredAt: row.occurredAt,
      payload: {
        // Amounts travel as decimal strings: jsonb has one number type and
        // it loses integers above 2^53 (money.ts says why).
        costMicros: row.costMicros.toString(),
        credentialSource: row.credentialSource,
        model: row.model,
        priceMicros: row.priceMicros.toString(),
        pricing: row.pricing,
        rounds: row.rounds,
        surface: row.surface,
        tokens: {
          cachedInput: row.cachedInputTokens,
          input: row.inputTokens,
          output: row.outputTokens,
          reasoning: row.reasoningTokens,
        },
        usageRecordId: row.id,
      },
      source: "metering",
      sourceRef: row.turnId,
    },
    options,
  );

  await db
    .update(aiUsageRecords)
    .set({ eventId: result.event.id })
    .where(eq(aiUsageRecords.id, row.id));

  return { entries: result.entries, eventId: result.event.id };
}

export interface SweepResult {
  failures: { error: unknown; turnId: string }[];
  posted: number;
  scanned: number;
}

// The nightly catch-up: every live billable record whose entries never
// landed. Bounded per run and oldest first, so a bad night is worked off in
// order rather than all at once.
export async function sweepUnpostedUsage(
  db: LedgerExecutor,
  options: PostEventOptions & {
    limit?: number | undefined;
    // Grace period: a record written seconds ago may still be mid-post in
    // the request that made it.
    olderThan?: Date | undefined;
  } = {},
): Promise<SweepResult> {
  const olderThan = options.olderThan ?? new Date(Date.now() - 5 * 60 * 1000);
  const rows = await db
    .select()
    .from(aiUsageRecords)
    .where(
      and(
        isNull(aiUsageRecords.eventId),
        eq(aiUsageRecords.meteringMode, "live"),
        lt(aiUsageRecords.createdAt, olderThan),
        sql`(${aiUsageRecords.costMicros} > 0 or ${aiUsageRecords.priceMicros} > 0)`,
      ),
    )
    .orderBy(asc(aiUsageRecords.createdAt))
    .limit(options.limit ?? 500);

  const result: SweepResult = { failures: [], posted: 0, scanned: rows.length };
  for (const row of rows) {
    try {
      await postUsageRecord(db, row, options);
      result.posted += 1;
    } catch (error) {
      // One poisonous record must not stop the rest of the night's work.
      result.failures.push({ error, turnId: row.turnId });
    }
  }
  return result;
}

async function loadRecordByTurn(
  db: LedgerExecutor,
  turnId: string,
): Promise<AiUsageRecord | undefined> {
  const [row] = await db
    .select()
    .from(aiUsageRecords)
    .where(eq(aiUsageRecords.turnId, turnId))
    .limit(1);
  return row ? toRecord(row) : undefined;
}

function toRecord(row: UsageRow): AiUsageRecord {
  return {
    accountId: row.accountId,
    costMicros: row.costMicros,
    currency: row.currency,
    eventId: row.eventId,
    id: row.id,
    meteringMode: row.meteringMode === "live" ? "live" : "shadow",
    model: row.model,
    priceMicros: row.priceMicros,
    turnId: row.turnId,
    usage: {
      cachedInputTokens: row.cachedInputTokens,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      reasoningTokens: row.reasoningTokens,
    },
  };
}

// A replay that could not read the row back — the record exists, this call
// just lost the race to see it. Shaped so callers never branch on undefined.
function emptyRecord(turnId: string, currency: string): AiUsageRecord {
  return {
    accountId: null,
    costMicros: 0n,
    currency,
    eventId: null,
    id: "",
    meteringMode: "shadow",
    model: "",
    priceMicros: 0n,
    turnId,
    usage: {
      cachedInputTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
    },
  };
}

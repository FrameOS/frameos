import { sql } from "drizzle-orm";
import { surfaceIsAbsorbed } from "./metering";
import type { LedgerExecutor } from "./types";

// What one account's AI usage looks like from the account's own side —
// §5.2/§5.3 of cloud/docs/accounting-todo.md. `reports.ts` answers the same
// shape of question for the operator across every account; this answers it
// for one account, and the two are deliberately separate because they mean
// different things by "spend": the operator wants what was booked, the
// customer wants what it will cost them.
//
// The one number this module exists to define is `chargeableMicros`, and it
// is defined ONCE and used twice — by the daily cap that refuses a turn
// (§5.3) and by the figure on the account page (§5.2). Two definitions of
// "what you have spent today" that disagree by a rounding step is the kind
// of bug that is only ever found by a confused user.
//
// It is not simply SUM(price_micros), because while metering is in shadow
// mode `price_micros` is 0 on every row: a cap built on it would never bite
// and would ship untested, and a page built on it would tell every user
// they had used nothing. So a turn's chargeable amount is what it WOULD be
// billed at, computed from the row's own pricing snapshot — its unit prices
// and the margin in force when it ran — rather than from today's settings.
// Once metering goes live the two coincide, and `checkAccountAiSpend` in
// the nightly job is what proves they did.

// The provider's list cost of a row's tokens, from the row's own snapshot,
// whoever actually paid for them. Own-key turns have `cost_micros = 0` (we
// paid nothing) but still burned real tokens, and the account page shows
// them — "you used $3 of AI on your own key" is a true and useful sentence.
const listCostExpression = sql`round(
  (input_tokens::numeric * coalesce(pricing->>'inputMicrosPerMtok', '0')::numeric
   + cached_input_tokens::numeric * coalesce(pricing->>'cachedInputMicrosPerMtok', '0')::numeric
   + output_tokens::numeric * coalesce(pricing->>'outputMicrosPerMtok', '0')::numeric)
  / 1000000)`;

// What this turn is worth to bill: the price if one was actually computed,
// otherwise the list cost marked up at the margin the row was metered under.
// Turns on the customer's own key are worth nothing to bill — they paid the
// provider directly — and are excluded here rather than zeroed, so that
// `ownKey` buckets keep their list cost for display.
const chargeableExpression = sql`case
  when credential_source = 'account' then 0
  when price_micros > 0 then price_micros
  else round(${listCostExpression}
    * (10000 + coalesce((pricing->>'marginBasisPoints')::numeric, 3000)) / 10000)
end`;

export interface AccountAiUsageBucket {
  // What this would be billed at (0 for own-key turns and absorbed
  // surfaces). See the note above on why this is not `priceMicros`.
  chargeableMicros: bigint;
  // What we actually paid the provider (0 when the key was not ours).
  costMicros: bigint;
  credentialSource: string;
  // The provider's list price of these tokens, whoever paid.
  listCostMicros: bigint;
  // What was actually charged and posted. 0 for every row in shadow mode.
  priceMicros: bigint;
  surface: string | null;
  turns: number;
}

export interface AccountAiUsage {
  buckets: AccountAiUsageBucket[];
  chargeableMicros: bigint;
  costMicros: bigint;
  listCostMicros: bigint;
  // True when every metered turn in the window ran on the account's own
  // OpenAI key: they owe us nothing, and a bill-shaped number would be a
  // lie rather than a zero.
  ownKeyOnly: boolean;
  priceMicros: bigint;
  turns: number;
}

export interface UsageWindow {
  since: Date;
  until: Date;
}

/**
 * One account's AI usage over a window, grouped by surface and by who paid.
 * Windowed on `occurred_at` — when the tokens were burned — rather than on
 * `created_at`, so a turn the sweep meters hours later still lands in the
 * day and the month it belongs to.
 */
export async function accountAiUsage(
  db: LedgerExecutor,
  accountId: string,
  window: UsageWindow,
): Promise<AccountAiUsage> {
  const rows = await db.execute<{
    chargeable_micros: string;
    cost_micros: string;
    credential_source: string;
    list_cost_micros: string;
    price_micros: string;
    surface: string | null;
    turns: string;
  }>(sql`
    select credential_source,
           surface,
           count(*)::text as turns,
           coalesce(sum(cost_micros), 0)::text as cost_micros,
           coalesce(sum(price_micros), 0)::text as price_micros,
           coalesce(sum(${listCostExpression}), 0)::text as list_cost_micros,
           coalesce(sum(${chargeableExpression}), 0)::text as chargeable_micros
      from ai_usage_records
     where account_id = ${accountId}
       and occurred_at >= ${window.since.toISOString()}::timestamptz
       and occurred_at < ${window.until.toISOString()}::timestamptz
     group by credential_source, surface
     order by credential_source, surface
  `);

  const buckets = rows.map((row) => ({
    // An absorbed surface (the legacy scene converter) is our migration
    // cost, never a line on anybody's bill — §5. Zeroed here rather than in
    // SQL because `absorbedSurfaces` is a TypeScript list that product
    // decisions edit, and threading it into a query would make it two
    // lists. The bucket keeps its cost and turn count, so the page can show
    // the work as done and free rather than hiding it.
    chargeableMicros: surfaceIsAbsorbed(row.surface)
      ? 0n
      : BigInt(row.chargeable_micros),
    costMicros: BigInt(row.cost_micros),
    credentialSource: row.credential_source,
    listCostMicros: BigInt(row.list_cost_micros),
    priceMicros: BigInt(row.price_micros),
    surface: row.surface,
    turns: Number(row.turns),
  }));

  const sum = (pick: (bucket: AccountAiUsageBucket) => bigint) =>
    buckets.reduce((total, bucket) => total + pick(bucket), 0n);
  return {
    buckets,
    chargeableMicros: sum((bucket) => bucket.chargeableMicros),
    costMicros: sum((bucket) => bucket.costMicros),
    listCostMicros: sum((bucket) => bucket.listCostMicros),
    ownKeyOnly:
      buckets.length > 0 &&
      buckets.every((bucket) => bucket.credentialSource === "account"),
    priceMicros: sum((bucket) => bucket.priceMicros),
    turns: buckets.reduce((total, bucket) => total + bucket.turns, 0),
  };
}

/**
 * The number the daily cap is checked against: what this account's AI usage
 * in the window is worth to bill. Same definition as the page's figure, by
 * construction — it is the same query.
 */
export async function accountAiSpendMicros(
  db: LedgerExecutor,
  accountId: string,
  window: UsageWindow,
): Promise<bigint> {
  return (await accountAiUsage(db, accountId, window)).chargeableMicros;
}

export interface AccountAiTurn {
  chatId: string | null;
  chargeableMicros: bigint;
  listCostMicros: bigint;
  model: string;
  occurredAt: Date;
  ownKey: boolean;
  surface: string | null;
}

/**
 * The most recent metered turns, newest first — the reconciliation surface a
 * user needs when a number surprises them (§5.2). Deliberately not a full
 * pagination API: twenty rows and "show more" answers "which turns did
 * this", and an account that needs a year of history needs an export, not a
 * deeper scroll.
 */
export async function recentAccountAiTurns(
  db: LedgerExecutor,
  accountId: string,
  options: { limit?: number | undefined } = {},
): Promise<AccountAiTurn[]> {
  const limit = Math.max(1, Math.min(200, options.limit ?? 20));
  const rows = await db.execute<{
    chargeable_micros: string;
    chat_id: string | null;
    credential_source: string;
    list_cost_micros: string;
    model: string;
    occurred_at: string;
    surface: string | null;
  }>(sql`
    select chat_id::text as chat_id,
           credential_source,
           model,
           surface,
           occurred_at,
           ${listCostExpression}::text as list_cost_micros,
           (${chargeableExpression})::text as chargeable_micros
      from ai_usage_records
     where account_id = ${accountId}
     order by occurred_at desc
     limit ${limit}
  `);
  return rows.map((row) => ({
    chargeableMicros: surfaceIsAbsorbed(row.surface)
      ? 0n
      : BigInt(row.chargeable_micros),
    chatId: row.chat_id,
    listCostMicros: BigInt(row.list_cost_micros),
    model: row.model,
    occurredAt: new Date(row.occurred_at),
    ownKey: row.credential_source === "account",
    surface: row.surface,
  }));
}

/**
 * The UTC day containing `at`. The cap's window, and UTC on purpose: one
 * definition, one index, no per-account timezone arithmetic on the hot path
 * of every turn. §8.12 has the open question about whether users should see
 * it that way.
 */
export function utcDayWindow(at: Date = new Date()): UsageWindow {
  const since = new Date(
    Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()),
  );
  const until = new Date(since.getTime() + 24 * 60 * 60 * 1000);
  return { since, until };
}

/**
 * A calendar month in UTC. `offset` counts backwards: 0 is the month
 * containing `at`, -1 the one before it (the account page shows both,
 * because the only way to know whether $1.27 is a lot is to see last
 * month's).
 */
export function utcMonthWindow(at: Date = new Date(), offset = 0): UsageWindow {
  const since = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + offset, 1));
  const until = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + offset + 1, 1));
  return { since, until };
}

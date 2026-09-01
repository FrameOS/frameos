import { sql } from "drizzle-orm";
import { absorbedSurfaces, surfaceIsAbsorbed } from "./metering";
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
export const listCostExpression = sql`round(
  (input_tokens::numeric * coalesce(pricing->>'inputMicrosPerMtok', '0')::numeric
   + cached_input_tokens::numeric * coalesce(pricing->>'cachedInputMicrosPerMtok', '0')::numeric
   + output_tokens::numeric * coalesce(pricing->>'outputMicrosPerMtok', '0')::numeric)
  / 1000000)`;

// What a turn on ONE OF OUR KEYS is worth at the customer's rate: the price
// if one was actually computed, otherwise the list cost marked up at the
// margin the row was metered under. Turns on the customer's own key are worth
// nothing — they paid the provider directly — and are excluded rather than
// zeroed, so an own-key bucket keeps its list cost for display.
//
// This is the CAP's number, and it deliberately includes `shared`. A turn on
// the operator's shared key is a real bill we absorb, so it belongs against a
// limit that exists to bound *our* exposure. It is NOT what the customer
// owes: see `billableExpression`.
//
// A credited turn — one whose charge entry was reversed — counts for nothing
// here: the books no longer charge for it, so neither may the page or the
// cap (§9.2 item 11). Exported because the cap invariant in integrity.ts
// must measure exactly what the gate measures, and a second copy of this
// expression is how the two drift apart.
export const chargeableExpression = sql`case
  when credential_source = 'account' then 0
  when credited_at is not null then 0
  when price_micros > 0 then price_micros
  else round(${listCostExpression}
    * (10000 + coalesce((pricing->>'marginBasisPoints')::numeric, 3000)) / 10000)
end`;

// `surface` not in the absorbed list, as SQL, built from the one TypeScript
// list so that a surface added to `absorbedSurfaces` is exempt everywhere at
// once — the gate, the page, and the nightly cap check.
export const notAbsorbedSurfaceCondition = sql`(surface is null or surface not in (${sql.join(
  absorbedSurfaces.map((surface) => sql`${surface}`),
  sql`, `,
)}))`;

// What the CUSTOMER owes, which is a narrower question and has to agree with
// `billing()` in metering.ts: only the platform key bills anybody. The
// operator's shared key is a cost we absorb on purpose and their own key cost
// us nothing, so neither is a line on anyone's invoice.
//
// Kept apart from the number above rather than folded into it, because
// conflating them shows a shared-key user a dollar figure they do not owe the
// moment metering goes live — which is exactly the kind of "bill-shaped lie"
// the own-key state already exists to avoid.
const billableExpression = sql`case
  when credential_source <> 'platform' then 0
  when credited_at is not null then 0
  when price_micros > 0 then price_micros
  else round(${listCostExpression}
    * (10000 + coalesce((pricing->>'marginBasisPoints')::numeric, 3000)) / 10000)
end`;

export interface AccountAiUsageBucket {
  // What the customer actually owes for this: platform-key turns only, and
  // never an absorbed surface. Agrees with `billing()` in metering.ts.
  billableMicros: bigint;
  // What this is worth at the customer's rate on any of OUR keys — the
  // number the daily cap is measured against, which includes the shared key
  // we absorb. Not a bill. See the note above on why it is not `priceMicros`.
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
  // True when nothing in the window is billable to the customer — every turn
  // ran on their own key, on the operator's absorbed shared key, or on a
  // surface we pay for. A dollar figure presented as a bill would be wrong.
  billableMicros: bigint;
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
    billable_micros: string;
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
           coalesce(sum(${chargeableExpression}), 0)::text as chargeable_micros,
           coalesce(sum(${billableExpression}), 0)::text as billable_micros
      from ai_usage_records
     where account_id = ${accountId}
       and occurred_at >= ${window.since.toISOString()}::timestamptz
       and occurred_at < ${window.until.toISOString()}::timestamptz
     group by credential_source, surface
     order by credential_source, surface
  `);

  const buckets = rows.map((row) => ({
    billableMicros: surfaceIsAbsorbed(row.surface)
      ? 0n
      : BigInt(row.billable_micros),
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
    billableMicros: sum((bucket) => bucket.billableMicros),
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
  // True when the charge for this turn was reversed after the fact.
  credited: boolean;
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
    credited_at: string | null;
    list_cost_micros: string;
    model: string;
    occurred_at: string;
    surface: string | null;
  }>(sql`
    select chat_id::text as chat_id,
           credential_source,
           credited_at,
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
    credited: row.credited_at !== null,
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

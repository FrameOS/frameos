import { sql } from "drizzle-orm";
import { chargeableExpression, notAbsorbedSurfaceCondition } from "./account-usage";
import { normalSideForType } from "./chart";
import { postingRules } from "./rules";
import type { LedgerAccountType, LedgerExecutor, PostingRuleRegistry } from "./types";

// The invariants, as queries. Each one is both a test and a nightly check:
// the suite proves the kernel upholds them on fresh data, the nightly job
// proves production still does. A ledger nobody checks is a ledger nobody
// can trust, and the failure mode of accounting bugs is silence.
export interface LedgerIntegrityViolation {
  check: string;
  detail: string;
}

export interface LedgerIntegrityOptions {
  // How many recent UTC days the cap check looks at. The gate is checked
  // every night; a day that passed last week's check does not need
  // re-judging against this week's cap, and an unbounded scan grows forever.
  capWindowDays?: number | undefined;
  // The daily spend ceiling in force (payg_daily_cap_micros). Omitted means
  // "no cap configured", and the check is skipped rather than assumed to be
  // zero — a missing setting must not report every account as a violation.
  dailyCapMicros?: bigint | undefined;
  now?: Date | undefined;
  // How far a customer's credit balance may go below zero before it counts
  // as a violation. Mirrors the payg_overdraft_micros setting.
  overdraftMicros?: bigint | undefined;
  // How long an event may sit unposted before it is a problem rather than a
  // sweep still in flight.
  pendingEventGraceMs?: number | undefined;
  rules?: PostingRuleRegistry | undefined;
}

export async function checkLedgerIntegrity(
  db: LedgerExecutor,
  options: LedgerIntegrityOptions = {},
): Promise<LedgerIntegrityViolation[]> {
  return [
    ...(await checkEntriesBalance(db)),
    ...(await checkAccountingEquation(db)),
    ...(await checkBalanceCache(db)),
    ...(await checkEventsPostedOnce(db, options)),
    ...(await checkCustomerCreditFloor(db, options)),
    ...(await checkDailyCapRespected(db, options)),
    ...(await checkMeteringCompleteness(db, options)),
    ...(await checkReversalsMirror(db)),
    ...(await checkImmutabilityTriggers(db)),
    ...(await checkDeferredSubscriptions(db)),
    ...(await checkPricesCameFromTheTable(db, options)),
  ];
}

// 1. Every entry balances, per currency. The kernel refuses unbalanced
//    drafts, so a violation here means something wrote postings behind its
//    back.
export async function checkEntriesBalance(
  db: LedgerExecutor,
): Promise<LedgerIntegrityViolation[]> {
  const rows = await db.execute<{
    currency: string;
    delta: string;
    entry_id: string;
  }>(sql`
    select p.entry_id::text as entry_id, p.currency,
           sum(case when p.direction = 'debit' then p.amount_micros else -p.amount_micros end) as delta
      from ledger_postings p
     group by p.entry_id, p.currency
    having sum(case when p.direction = 'debit' then p.amount_micros else -p.amount_micros end) <> 0
  `);
  return rows.map((row) => ({
    check: "entries_balance",
    detail: `Entry ${row.entry_id} is out of balance by ${row.delta} ${row.currency} micros`,
  }));
}

// 2. The accounting equation: assets + expenses + contra-revenue equal
//    liabilities + equity + revenue, each account signed by the side its
//    TYPE says is normal. Summing raw debits against raw credits — what this
//    check used to do — is guaranteed by check 1 and catches nothing on its
//    own (§9.2 item 13). Signing by type instead catches the thing double
//    entry cannot: an account whose `normal_side` disagrees with its type,
//    which makes every balance and every report on it read backwards while
//    every entry still balances perfectly.
export async function checkAccountingEquation(
  db: LedgerExecutor,
): Promise<LedgerIntegrityViolation[]> {
  const mislabelled = await db.execute<{
    code: string;
    normal_side: string;
    type: string;
  }>(sql`select code, type, normal_side from ledger_accounts`);
  const wrongSide = mislabelled.filter(
    (row) => normalSideForType(row.type as LedgerAccountType) !== row.normal_side,
  );

  const rows = await db.execute<{
    currency: string;
    debit_normal: string;
    credit_normal: string;
  }>(sql`
    select p.currency,
           coalesce(sum(case when a.type in ('asset', 'expense', 'contra_revenue')
                             then case when p.direction = 'debit' then p.amount_micros else -p.amount_micros end
                             else 0 end), 0) as debit_normal,
           coalesce(sum(case when a.type in ('liability', 'equity', 'revenue')
                             then case when p.direction = 'credit' then p.amount_micros else -p.amount_micros end
                             else 0 end), 0) as credit_normal
      from ledger_postings p
      join ledger_accounts a on a.id = p.ledger_account_id
     group by p.currency
  `);
  return [
    ...wrongSide.map((row) => ({
      check: "accounting_equation",
      detail: `${row.code} is a ${row.type} account with normal side ${row.normal_side}; every balance on it reads backwards`,
    })),
    ...rows
      .filter((row) => BigInt(row.debit_normal) !== BigInt(row.credit_normal))
      .map((row) => ({
        check: "accounting_equation",
        detail: `${row.currency}: assets + expenses + contra (${row.debit_normal}) do not equal liabilities + equity + revenue (${row.credit_normal})`,
      })),
  ];
}

// 3. The cache is honest: ledger_balances equals the sum over postings, for
//    every account. If these ever disagree, the postings are right.
export async function checkBalanceCache(
  db: LedgerExecutor,
): Promise<LedgerIntegrityViolation[]> {
  const rows = await db.execute<{
    actual: string;
    cached: string;
    code: string;
  }>(sql`
    select a.code,
           coalesce(b.balance_micros, 0) as cached,
           coalesce(sum(case when p.direction = a.normal_side
                             then p.amount_micros else -p.amount_micros end), 0) as actual
      from ledger_accounts a
      left join ledger_balances b on b.ledger_account_id = a.id
      left join ledger_postings p on p.ledger_account_id = a.id
     group by a.code, b.balance_micros
    having coalesce(b.balance_micros, 0) <> coalesce(sum(case when p.direction = a.normal_side
                                                              then p.amount_micros else -p.amount_micros end), 0)
  `);
  return rows.map((row) => ({
    check: "balance_cache",
    detail: `${row.code}: cached ${row.cached} micros, postings say ${row.actual}`,
  }));
}

// 4. Events post exactly once: nothing sits unposted past the grace period,
//    and no event produced the same entry type twice unless its rule says it
//    may.
export async function checkEventsPostedOnce(
  db: LedgerExecutor,
  options: LedgerIntegrityOptions = {},
): Promise<LedgerIntegrityViolation[]> {
  const now = options.now ?? new Date();
  const grace = options.pendingEventGraceMs ?? 15 * 60 * 1000;
  // postgres.js binds a Date only through drizzle's own column encoders; a
  // raw query has to hand it an ISO string and say what it is.
  const cutoff = new Date(now.getTime() - grace);
  const rules = options.rules ?? postingRules;

  const pending = await db.execute<{
    event_type: string;
    id: string;
    idempotency_key: string;
  }>(sql`
    select id::text as id, event_type, idempotency_key
      from financial_events
     where processed_at is null
       and created_at < ${cutoff.toISOString()}::timestamptz
  `);

  const repeated = await db.execute<{
    entry_count: string;
    entry_type: string;
    event_id: string;
    event_type: string;
  }>(sql`
    select l.event_id::text as event_id, e.event_type, l.entry_type, count(*) as entry_count
      from ledger_entries l
      join financial_events e on e.id = l.event_id
     group by l.event_id, e.event_type, l.entry_type
    having count(*) > 1
  `);

  return [
    ...pending.map((row) => ({
      check: "events_posted_once",
      detail: `${row.event_type} event ${row.idempotency_key} has been unposted since before ${cutoff.toISOString()}`,
    })),
    ...repeated
      .filter((row) => !rules[row.event_type]?.allowsRepeatedEntryTypes)
      .map((row) => ({
        check: "events_posted_once",
        detail: `Event ${row.event_id} posted ${row.entry_count} ${row.entry_type} entries`,
      })),
  ];
}

// 5. No customer spends further into the red than policy allows. Promo
//    credits carry no overdraft: a grant cannot be overdrawn at all.
export async function checkCustomerCreditFloor(
  db: LedgerExecutor,
  options: LedgerIntegrityOptions = {},
): Promise<LedgerIntegrityViolation[]> {
  const floor = -(options.overdraftMicros ?? 0n);
  const rows = await db.execute<{ balance_micros: string; code: string }>(sql`
    select a.code, b.balance_micros
      from ledger_accounts a
      join ledger_balances b on b.ledger_account_id = a.id
     where (a.code like 'liability:credits:customer:%' and b.balance_micros < ${floor.toString()}::bigint)
        or (a.code like 'liability:credits_promo:customer:%' and b.balance_micros < 0)
  `);
  return rows.map((row) => ({
    check: "customer_credit_floor",
    detail: `${row.code} is at ${row.balance_micros} micros`,
  }));
}

// 5b. The daily cap held. Under postpay this is the check that matters
//     — there is no prepaid balance to keep out of the red, and the cap is
//     what bounds the credit risk instead (§5.3). It is also the only
//     automated proof that the gate in resolveAiAccess() actually sits in
//     front of EVERY AI surface rather than most of them: a surface added
//     next month that forgets it shows up here as a day over the line.
//
//     Measured the same way the gate measures, on `ai_usage_records` rather
//     than on postings, because the cap must hold for shadow-mode and
//     own-key accounts too — and those post nothing at all.
//
//     The tolerated overshoot is one turn's worth (`payg_overdraft_micros`):
//     the gate refuses at the cap, a turn's cost is unknown until it ends,
//     and the runner stops a turn mid-flight once it reaches cap + overdraft
//     — so anything past that is the gate failing. (Two turns started at
//     once can each overshoot; at today's volume that is rare enough to
//     read as an alert and look at, rather than a reason to reserve spend
//     in flight.)
//
//     The amount is the SAME SQL the gate and the account page use,
//     imported rather than copied: a second spelling of "what a turn is
//     worth" is how the check and the gate drift apart (§9.2 item 7). Only
//     the last `capWindowDays` days are looked at — the check runs nightly,
//     and re-judging last year's days against this year's cap is noise.
export async function checkDailyCapRespected(
  db: LedgerExecutor,
  options: LedgerIntegrityOptions = {},
): Promise<LedgerIntegrityViolation[]> {
  const cap = options.dailyCapMicros;
  if (cap === undefined || cap <= 0n) {
    return [];
  }
  const ceiling = cap + (options.overdraftMicros ?? 0n);
  const now = options.now ?? new Date();
  const windowDays = Math.max(1, options.capWindowDays ?? 7);
  const since = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (windowDays - 1)),
  );
  const rows = await db.execute<{
    account_id: string;
    day: string;
    spent: string;
  }>(sql`
    select account_id::text as account_id,
           to_char(date_trunc('day', occurred_at at time zone 'UTC'), 'YYYY-MM-DD') as day,
           sum(${chargeableExpression})::text as spent
      from ai_usage_records
     where account_id is not null
       and occurred_at >= ${since.toISOString()}::timestamptz
       and ${notAbsorbedSurfaceCondition}
     group by 1, 2
    having sum(${chargeableExpression}) > ${ceiling.toString()}::numeric
  `);
  return rows.map((row) => ({
    check: "daily_cap_respected",
    detail: `Account ${row.account_id} metered ${row.spent} micros on ${row.day}, past the ${ceiling.toString()} ceiling`,
  }));
}

// 6. Metering is complete: every usage record that should be in the books is
//    in the books. "Should be" is narrow on purpose — a shadow-mode record
//    posts nothing by design, and a turn on the customer's own key cost us
//    nothing and is charged nothing, so neither is a violation. What is left
//    is a live billable record whose entries never landed, which means the
//    sweep is not running or is failing on it.
export async function checkMeteringCompleteness(
  db: LedgerExecutor,
  options: LedgerIntegrityOptions = {},
): Promise<LedgerIntegrityViolation[]> {
  const now = options.now ?? new Date();
  const grace = options.pendingEventGraceMs ?? 15 * 60 * 1000;
  const cutoff = new Date(now.getTime() - grace);
  const rows = await db.execute<{ count: string; oldest: string; turn_id: string }>(sql`
    select count(*) as count,
           min(created_at)::text as oldest,
           (array_agg(turn_id::text order by created_at))[1] as turn_id
      from ai_usage_records
     where event_id is null
       and metering_mode = 'live'
       and (cost_micros > 0 or price_micros > 0)
       and created_at < ${cutoff.toISOString()}::timestamptz
    having count(*) > 0
  `);
  return rows.map((row) => ({
    check: "metering_completeness",
    detail: `${row.count} billable usage record(s) have never posted, oldest ${row.oldest} (turn ${row.turn_id})`,
  }));
}

// 7. A reversal mirrors its target leg for leg: summing the pair together
//    must come to nothing on every account and currency they touch.
export async function checkReversalsMirror(
  db: LedgerExecutor,
): Promise<LedgerIntegrityViolation[]> {
  const rows = await db.execute<{ entry_id: string; reverses: string }>(sql`
    select r.id::text as entry_id, r.reverses_entry_id::text as reverses
      from ledger_entries r
     where r.reverses_entry_id is not null
       and exists (
         select 1
           from ledger_postings p
          where p.entry_id in (r.id, r.reverses_entry_id)
          group by p.ledger_account_id, p.currency
         having sum(case when p.direction = 'debit' then p.amount_micros else -p.amount_micros end) <> 0
       )
  `);
  return rows.map((row) => ({
    check: "reversals_mirror",
    detail: `Entry ${row.entry_id} does not mirror the entry it reverses (${row.reverses})`,
  }));
}

// 9. Deferred subscription revenue is exactly the periods we have charged
//    and not yet recognised, net of what was refunded early. Nothing used to
//    check this account at all, and the two ways it goes wrong are both
//    silent: a period row that disappears (an account deleted while a
//    cascade still reached it — §9.2 item 4) leaves a balance nothing will
//    ever earn, and a recognition that ignores a refund drives it negative.
export async function checkDeferredSubscriptions(
  db: LedgerExecutor,
): Promise<LedgerIntegrityViolation[]> {
  const [row] = await db.execute<{ booked: string; deferred: string }>(sql`
    select
      (select coalesce(sum(case when p.direction = a.normal_side
                                then p.amount_micros else -p.amount_micros end), 0)
         from ledger_postings p
         join ledger_accounts a on a.id = p.ledger_account_id
        where a.code = 'liability:deferred:subscriptions') as deferred,
      (select coalesce(sum(price_micros - refunded_micros), 0)
         from subscription_periods
        where charged_at is not null and recognized_at is null) as booked
  `);
  if (!row || BigInt(row.deferred) === BigInt(row.booked)) {
    return [];
  }
  return [
    {
      check: "deferred_subscriptions",
      detail: `liability:deferred:subscriptions holds ${row.deferred} micros; the charged, unrecognised periods say ${row.booked}`,
    },
  ];
}

// 10. Every recent turn priced off the price table. A model the table does
//     not know prices at a deliberately high fallback so its spend is never
//     hidden — but "deliberately high" is still wrong, and until now the
//     only trace of it was a field inside the pricing jsonb that nobody
//     reads (§9.2 item 17). A new model id, a dated snapshot, a rename: each
//     shows up here the night it first runs.
export async function checkPricesCameFromTheTable(
  db: LedgerExecutor,
  options: LedgerIntegrityOptions = {},
): Promise<LedgerIntegrityViolation[]> {
  const now = options.now ?? new Date();
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const rows = await db.execute<{ count: string; model: string; source: string }>(sql`
    select model, coalesce(pricing->>'priceSource', 'missing') as source, count(*) as count
      from ai_usage_records
     where created_at >= ${since.toISOString()}::timestamptz
       and coalesce(pricing->>'priceSource', 'missing') <> 'table'
     group by 1, 2
  `);
  return rows.map((row) => ({
    check: "prices_from_table",
    detail: `${row.count} turn(s) on ${row.model} priced from the ${row.source} price, not ai_model_prices — add a row for it`,
  }));
}

// 8. The append-only triggers are still installed. Dropping one would make
//    every other check above only as good as the code that writes the rows.
export async function checkImmutabilityTriggers(
  db: LedgerExecutor,
): Promise<LedgerIntegrityViolation[]> {
  const expected = [
    "financial_events_append_only",
    "ledger_entries_immutable",
    "ledger_postings_immutable",
  ];
  const rows = await db.execute<{ tgname: string }>(sql`
    select tgname from pg_trigger where not tgisinternal
  `);
  const installed = new Set(rows.map((row) => row.tgname));
  return expected
    .filter((name) => !installed.has(name))
    .map((name) => ({
      check: "immutability_triggers",
      detail: `Trigger ${name} is missing: the ledger is no longer append-only in the database`,
    }));
}

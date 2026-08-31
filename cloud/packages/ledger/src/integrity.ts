import { sql } from "drizzle-orm";
import { postingRules } from "./rules";
import type { LedgerExecutor, PostingRuleRegistry } from "./types";

// The invariants, as queries. Each one is both a test and a nightly check:
// the suite proves the kernel upholds them on fresh data, the nightly job
// proves production still does. A ledger nobody checks is a ledger nobody
// can trust, and the failure mode of accounting bugs is silence.
export interface LedgerIntegrityViolation {
  check: string;
  detail: string;
}

export interface LedgerIntegrityOptions {
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
    ...(await checkReversalsMirror(db)),
    ...(await checkImmutabilityTriggers(db)),
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

// 2. The accounting equation, in its rawest form: across the whole book,
//    debits equal credits. Every other statement of it (assets = liabilities
//    + equity + revenue − contra − expenses) is this identity rearranged.
export async function checkAccountingEquation(
  db: LedgerExecutor,
): Promise<LedgerIntegrityViolation[]> {
  const rows = await db.execute<{
    credits: string;
    currency: string;
    debits: string;
  }>(sql`
    select currency,
           coalesce(sum(case when direction = 'debit' then amount_micros else 0 end), 0) as debits,
           coalesce(sum(case when direction = 'credit' then amount_micros else 0 end), 0) as credits
      from ledger_postings
     group by currency
  `);
  return rows
    .filter((row) => BigInt(row.debits) !== BigInt(row.credits))
    .map((row) => ({
      check: "accounting_equation",
      detail: `${row.currency}: debits ${row.debits} do not equal credits ${row.credits}`,
    }));
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

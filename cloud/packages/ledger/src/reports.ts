import { asc, eq, sql } from "drizzle-orm";
import { ledgerAccountGroups, ledgerAccounts } from "@frameos-cloud/db";
import { describeAccountCode } from "./chart";
import {
  LedgerError,
  type LedgerAccountType,
  type LedgerExecutor,
  type PostingDirection,
} from "./types";

// Books somebody can actually read. Every function here is a query over the
// same postings the kernel wrote — there is no second store, no derived
// report table, and no nightly rollup, which is what makes a number on the
// admin page debuggable by drilling into it rather than by re-deriving it.
//
// All of it reads from `ledger_postings` rather than from `ledger_balances`.
// The cache exists to make the spend gate fast on one account; a report that
// trusted it would be a report that cannot notice the cache is wrong, and
// noticing that is invariant 3's whole job.

export interface TrialBalanceRow {
  accountCode: string;
  balanceMicros: bigint;
  cachedBalanceMicros: bigint;
  creditMicros: bigint;
  currency: string;
  debitMicros: bigint;
  groupCode: string | null;
  groupName: string | null;
  ledgerAccountId: string;
  normalSide: PostingDirection;
  ownerAccountId: string | null;
  type: LedgerAccountType;
}

export interface TrialBalance {
  // The equality that has to hold. Shown rather than asserted: a trial
  // balance whose two totals differ is the single most useful thing an
  // accounting page can tell you, and hiding it behind a passing test would
  // be the wrong place to find out.
  balanced: boolean;
  currency: string;
  rows: TrialBalanceRow[];
  totalCreditMicros: bigint;
  totalDebitMicros: bigint;
}

// Every account with its debit and credit totals, grouped for reporting.
// Accounts that have never been posted to are included at zero: an empty row
// is information ("nothing has ever hit refunds payable"), and a chart with
// holes in it is harder to trust than one full of zeroes.
export async function trialBalance(
  db: LedgerExecutor,
  options: { currency?: string | undefined } = {},
): Promise<TrialBalance> {
  const currency = options.currency ?? "USD";
  const rows = await db.execute<{
    balance: string;
    cached: string;
    code: string;
    credits: string;
    debits: string;
    group_code: string | null;
    group_name: string | null;
    id: string;
    normal_side: string;
    owner_account_id: string | null;
    type: string;
  }>(sql`
    select a.id::text as id,
           a.code,
           a.type,
           a.normal_side,
           a.owner_account_id::text as owner_account_id,
           g.code as group_code,
           g.name as group_name,
           coalesce(b.balance_micros, 0)::text as cached,
           coalesce(sum(case when p.direction = 'debit' then p.amount_micros else 0 end), 0)::text as debits,
           coalesce(sum(case when p.direction = 'credit' then p.amount_micros else 0 end), 0)::text as credits,
           coalesce(sum(case when p.direction = a.normal_side
                             then p.amount_micros else -p.amount_micros end), 0)::text as balance
      from ledger_accounts a
      left join ledger_account_groups g on g.id = a.group_id
      left join ledger_balances b on b.ledger_account_id = a.id
      left join ledger_postings p
             on p.ledger_account_id = a.id and p.currency = ${currency}
     where a.currency = ${currency}
     group by a.id, a.code, a.type, a.normal_side, a.owner_account_id, g.code, g.name, g.sort_order, b.balance_micros
     order by g.sort_order nulls last, a.code
  `);

  const mapped: TrialBalanceRow[] = rows.map((row) => ({
      accountCode: row.code,
      balanceMicros: BigInt(row.balance),
      cachedBalanceMicros: BigInt(row.cached),
      creditMicros: BigInt(row.credits),
      currency,
      debitMicros: BigInt(row.debits),
      groupCode: row.group_code,
      groupName: row.group_name,
      ledgerAccountId: row.id,
      normalSide: row.normal_side as PostingDirection,
    ownerAccountId: row.owner_account_id,
    type: row.type as LedgerAccountType,
  }));

  const totalDebitMicros = mapped.reduce((sum, row) => sum + row.debitMicros, 0n);
  const totalCreditMicros = mapped.reduce((sum, row) => sum + row.creditMicros, 0n);
  return {
    balanced: totalDebitMicros === totalCreditMicros,
    currency,
    rows: mapped,
    totalCreditMicros,
    totalDebitMicros,
  };
}

export interface JournalPosting {
  accountCode: string;
  amountMicros: bigint;
  currency: string;
  direction: PostingDirection;
  ownerAccountId: string | null;
}

export interface JournalEntry {
  description: string;
  entryType: string;
  eventId: string;
  eventIdempotencyKey: string;
  eventSource: string;
  eventType: string;
  externalRef: string | null;
  id: string;
  metadata: Record<string, unknown>;
  occurredAt: Date;
  postedAt: Date;
  postings: JournalPosting[];
  reversedByEntryId: string | null;
  reversesEntryId: string | null;
  ruleVersion: number;
}

export interface JournalFilter {
  accountCode?: string | undefined;
  before?: Date | undefined;
  entryType?: string | undefined;
  eventId?: string | undefined;
  limit?: number | undefined;
  ownerAccountId?: string | undefined;
  since?: Date | undefined;
}

// The journal, newest first, with every leg. One query for the headers and
// one for their postings rather than a join that would multiply the headers
// by their legs and need de-duplicating in TypeScript.
export async function listJournalEntries(
  db: LedgerExecutor,
  filter: JournalFilter = {},
): Promise<JournalEntry[]> {
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
  const headers = await db.execute<{
    description: string;
    entry_type: string;
    event_id: string;
    event_source: string;
    event_type: string;
    external_ref: string | null;
    id: string;
    idempotency_key: string;
    metadata: Record<string, unknown> | null;
    occurred_at: string;
    posted_at: string;
    reversed_by: string | null;
    reverses_entry_id: string | null;
    rule_version: number;
  }>(sql`
    select l.id::text as id,
           l.entry_type,
           l.rule_version,
           l.description,
           l.occurred_at,
           l.posted_at,
           l.external_ref,
           l.metadata,
           l.reverses_entry_id::text as reverses_entry_id,
           r.id::text as reversed_by,
           e.id::text as event_id,
           e.event_type,
           e.source as event_source,
           e.idempotency_key
      from ledger_entries l
      join financial_events e on e.id = l.event_id
      left join ledger_entries r on r.reverses_entry_id = l.id
      -- Insertion order. posted_at is transaction time, so the two entries a
      -- metered turn posts share it exactly, and a uuid tiebreak would
      -- shuffle them on every reload. Postings carry the one monotonic
      -- sequence in the ledger.
      left join lateral (
        select min(p2.id) as seq from ledger_postings p2 where p2.entry_id = l.id
      ) s on true
     where true
       ${filter.entryType ? sql`and l.entry_type = ${filter.entryType}` : sql``}
       ${filter.eventId ? sql`and l.event_id = ${filter.eventId}::uuid` : sql``}
       ${filter.since ? sql`and l.occurred_at >= ${filter.since.toISOString()}::timestamptz` : sql``}
       ${filter.before ? sql`and l.occurred_at < ${filter.before.toISOString()}::timestamptz` : sql``}
       ${
         filter.accountCode
           ? sql`and exists (
               select 1 from ledger_postings p
                 join ledger_accounts a on a.id = p.ledger_account_id
                where p.entry_id = l.id and a.code = ${filter.accountCode})`
           : sql``
       }
       ${
         filter.ownerAccountId
           ? sql`and (e.account_id = ${filter.ownerAccountId}::uuid or exists (
               select 1 from ledger_postings p
                 join ledger_accounts a on a.id = p.ledger_account_id
                where p.entry_id = l.id and a.owner_account_id = ${filter.ownerAccountId}::uuid))`
           : sql``
       }
     order by l.occurred_at desc, s.seq desc
     limit ${limit}
  `);
  if (headers.length === 0) {
    return [];
  }

  const entryIds = headers.map((header) => header.id);
  const postings = await db.execute<{
    amount_micros: string;
    code: string;
    currency: string;
    direction: string;
    entry_id: string;
    owner_account_id: string | null;
  }>(sql`
    select p.entry_id::text as entry_id,
           a.code,
           a.owner_account_id::text as owner_account_id,
           p.direction,
           p.amount_micros::text as amount_micros,
           p.currency
      from ledger_postings p
      join ledger_accounts a on a.id = p.ledger_account_id
     where p.entry_id in (${sql.join(
       entryIds.map((id) => sql`${id}::uuid`),
       sql`, `,
     )})
     order by p.id
  `);

  return headers.map((header) => ({
    description: header.description,
    entryType: header.entry_type,
    eventId: header.event_id,
    eventIdempotencyKey: header.idempotency_key,
    eventSource: header.event_source,
    eventType: header.event_type,
    externalRef: header.external_ref,
    id: header.id,
    metadata: header.metadata ?? {},
    occurredAt: new Date(header.occurred_at),
    postedAt: new Date(header.posted_at),
    postings: postings
      .filter((posting) => posting.entry_id === header.id)
      .map((posting) => ({
        accountCode: posting.code,
        amountMicros: BigInt(posting.amount_micros),
        currency: posting.currency,
        direction: posting.direction as PostingDirection,
        ownerAccountId: posting.owner_account_id,
      })),
    reversedByEntryId: header.reversed_by,
    reversesEntryId: header.reverses_entry_id,
    ruleVersion: header.rule_version,
  }));
}

export interface CustomerStatementLine {
  accountCode: string;
  amountMicros: bigint;
  balanceMicros: bigint;
  description: string;
  direction: PostingDirection;
  entryId: string;
  entryType: string;
  occurredAt: Date;
}

export interface CustomerStatement {
  accountCode: string;
  // Running balance after the last line, signed the account's normal way.
  closingBalanceMicros: bigint;
  lines: CustomerStatementLine[];
}

// One customer's credit account, oldest first, with a running balance —
// the view support needs when somebody asks "where did my credit go".
//
// The ledger holds an account uuid and no name (§2.1): whatever renders this
// resolves the label from `accounts` live and shows the bare uuid when the
// lookup fails, because the customer may have been erased and their books
// deliberately have not been.
export async function customerStatement(
  db: LedgerExecutor,
  accountCode: string,
  options: { limit?: number | undefined } = {},
): Promise<CustomerStatement> {
  // Refuse a code the chart does not recognize rather than returning an
  // empty statement that looks like "this customer spent nothing".
  describeAccountCode(accountCode);
  const limit = Math.min(Math.max(options.limit ?? 200, 1), 1000);
  const rows = await db.execute<{
    amount_micros: string;
    description: string;
    direction: string;
    entry_id: string;
    entry_type: string;
    normal_side: string;
    occurred_at: string;
  }>(sql`
    select l.id::text as entry_id,
           l.entry_type,
           l.description,
           l.occurred_at,
           p.direction,
           p.amount_micros::text as amount_micros,
           a.normal_side
      from ledger_postings p
      join ledger_accounts a on a.id = p.ledger_account_id
      join ledger_entries l on l.id = p.entry_id
     where a.code = ${accountCode}
     order by l.occurred_at, l.posted_at, p.id
     limit ${limit}
  `);

  let running = 0n;
  const lines = rows.map((row) => {
    const amountMicros = BigInt(row.amount_micros);
    running +=
      row.direction === row.normal_side ? amountMicros : -amountMicros;
    return {
      accountCode,
      amountMicros,
      balanceMicros: running,
      description: row.description,
      direction: row.direction as PostingDirection,
      entryId: row.entry_id,
      entryType: row.entry_type,
      occurredAt: new Date(row.occurred_at),
    };
  });
  return { accountCode, closingBalanceMicros: running, lines };
}

export interface LedgerAccountGroup {
  code: string;
  id: string;
  name: string;
  parentId: string | null;
  sortOrder: number;
}

export async function listAccountGroups(
  db: LedgerExecutor,
): Promise<LedgerAccountGroup[]> {
  const rows = await db
    .select()
    .from(ledgerAccountGroups)
    .orderBy(asc(ledgerAccountGroups.sortOrder), asc(ledgerAccountGroups.code));
  return rows.map((row) => ({
    code: row.code,
    id: row.id,
    name: row.name,
    parentId: row.parentId,
    sortOrder: row.sortOrder,
  }));
}

export async function createAccountGroup(
  db: LedgerExecutor,
  input: { code: string; name: string; parentId?: string | null | undefined; sortOrder?: number | undefined },
): Promise<LedgerAccountGroup> {
  const code = input.code.trim().toLowerCase();
  if (!/^[a-z0-9_]{2,64}$/.test(code)) {
    throw new LedgerError(
      "invalid_draft",
      "A group code is 2-64 lowercase letters, digits or underscores",
    );
  }
  if (!input.name.trim()) {
    throw new LedgerError("invalid_draft", "A group needs a name");
  }
  const [row] = await db
    .insert(ledgerAccountGroups)
    .values({
      code,
      name: input.name.trim(),
      parentId: input.parentId ?? null,
      sortOrder: input.sortOrder ?? 100,
    })
    .returning();
  if (!row) {
    throw new LedgerError("invalid_draft", `Group ${code} already exists`);
  }
  return {
    code: row.code,
    id: row.id,
    name: row.name,
    parentId: row.parentId,
    sortOrder: row.sortOrder,
  };
}

// Mechanism 1 of §1.3: re-bucket an account for reporting. Mutable and free
// of accounting consequence — no posting moves, no balance changes, every
// report simply groups differently from the next render. If an *amount* is
// in the wrong place, that is the reclassification recipe instead.
export async function setAccountGroup(
  db: LedgerExecutor,
  ledgerAccountId: string,
  groupId: string | null,
): Promise<void> {
  await db
    .update(ledgerAccounts)
    .set({ groupId })
    .where(eq(ledgerAccounts.id, ledgerAccountId));
}

export interface DailySummary {
  cogsMicros: bigint;
  // Promo credit granted in the window. Kept apart from revenue rather than
  // folded into it, because the two move at different times: a grant is
  // recognized when it is made, and the revenue it will offset arrives
  // whenever the customer gets round to spending it.
  contraRevenueMicros: bigint;
  customerLiabilityMicros: bigint;
  // Revenue net of contra, less cost. The number the business runs on.
  marginMicros: bigint;
  netRevenueMicros: bigint;
  revenueMicros: bigint;
  since: Date;
  until: Date;
}

// The one line the nightly job logs: what the books did today. Revenue and
// COGS over the window, the margin between them, and the total we currently
// owe customers in prepaid credit — the number that is a liability rather
// than money we have earned.
export async function dailySummary(
  db: LedgerExecutor,
  window: { since: Date; until: Date },
): Promise<DailySummary> {
  const [row] = await db.execute<{
    cogs: string;
    contra: string;
    revenue: string;
  }>(sql`
    select
      coalesce(sum(case when a.type = 'revenue'
                        then case when p.direction = 'credit' then p.amount_micros else -p.amount_micros end
                        else 0 end), 0)::text as revenue,
      coalesce(sum(case when a.type = 'contra_revenue'
                        then case when p.direction = 'debit' then p.amount_micros else -p.amount_micros end
                        else 0 end), 0)::text as contra,
      coalesce(sum(case when a.type = 'expense'
                        then case when p.direction = 'debit' then p.amount_micros else -p.amount_micros end
                        else 0 end), 0)::text as cogs
      from ledger_postings p
      join ledger_accounts a on a.id = p.ledger_account_id
      join ledger_entries l on l.id = p.entry_id
     where l.occurred_at >= ${window.since.toISOString()}::timestamptz
       and l.occurred_at < ${window.until.toISOString()}::timestamptz
  `);
  const [liability] = await db.execute<{ owed: string }>(sql`
    select coalesce(sum(b.balance_micros), 0)::text as owed
      from ledger_balances b
      join ledger_accounts a on a.id = b.ledger_account_id
     where a.code like 'liability:credits%:customer:%'
  `);

  const revenueMicros = BigInt(row?.revenue ?? "0");
  const contraRevenueMicros = BigInt(row?.contra ?? "0");
  const cogsMicros = BigInt(row?.cogs ?? "0");
  const netRevenueMicros = revenueMicros - contraRevenueMicros;
  return {
    cogsMicros,
    contraRevenueMicros,
    customerLiabilityMicros: BigInt(liability?.owed ?? "0"),
    marginMicros: netRevenueMicros - cogsMicros,
    netRevenueMicros,
    revenueMicros,
    since: window.since,
    until: window.until,
  };
}

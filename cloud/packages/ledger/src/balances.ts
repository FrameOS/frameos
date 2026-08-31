import { eq, sql } from "drizzle-orm";
import { ledgerAccounts, ledgerBalances } from "@frameos-cloud/db";
import { customerCreditsCode, customerPromoCreditsCode } from "./chart";
import type { LedgerExecutor } from "./types";

// Signed so that positive means "on this account's normal side": a customer
// credit account at +5,000,000 is five dollars we owe them. Reads the cache;
// the nightly integrity check is what keeps the cache honest.
export async function accountBalanceMicros(
  db: LedgerExecutor,
  code: string,
): Promise<bigint> {
  const [row] = await db
    .select({ balanceMicros: ledgerBalances.balanceMicros })
    .from(ledgerBalances)
    .innerJoin(
      ledgerAccounts,
      eq(ledgerAccounts.id, ledgerBalances.ledgerAccountId),
    )
    .where(eq(ledgerAccounts.code, code))
    .limit(1);
  return row?.balanceMicros ?? 0n;
}

// What a customer can still spend: bought credits plus granted ones, plus
// whatever overdraft policy allows. A turn's cost is unknown until it ends,
// so the gate lets a customer with any balance left start one and catches
// the shortfall on the next — the overdraft is how much of that overshoot we
// accept before saying no.
export async function availableCreditMicros(
  db: LedgerExecutor,
  accountId: string,
  options: { overdraftMicros?: bigint | undefined } = {},
): Promise<bigint> {
  const paid = await accountBalanceMicros(db, customerCreditsCode(accountId));
  const promo = await accountBalanceMicros(
    db,
    customerPromoCreditsCode(accountId),
  );
  return paid + promo + (options.overdraftMicros ?? 0n);
}

// Straight from the postings rather than the cache: the slow, always-correct
// answer, for the integrity checker and for anything reconciling a dispute.
export async function accountBalanceFromPostings(
  db: LedgerExecutor,
  code: string,
): Promise<bigint> {
  const rows = await db.execute<{ balance: string | null }>(sql`
    select coalesce(sum(case when p.direction = a.normal_side
                             then p.amount_micros else -p.amount_micros end), 0) as balance
      from ledger_accounts a
      left join ledger_postings p on p.ledger_account_id = a.id
     where a.code = ${code}
  `);
  return BigInt(rows[0]?.balance ?? "0");
}

import { sql } from "drizzle-orm";
import { accounts, createDb } from "@frameos-cloud/db";
import { resolveTestDatabaseUrl } from "./test-database-url";

export const db = createDb(resolveTestDatabaseUrl());

// Everything the tests write, and nothing the migration seeded: the system
// chart of accounts and its groups have to survive, because half of what
// these tests check is that the seed is what the kernel finds waiting for it.
// Customer subaccounts are the kernel's own doing, so those do go.
export async function resetLedger() {
  await db.execute(sql`
    TRUNCATE TABLE ai_usage_records, ledger_postings, ledger_balances, ledger_entries, financial_events
  `);
  // Subscriptions no longer cascade from accounts (migration 0046), so they
  // have to go explicitly — and a test that never made an account must not
  // inherit the last one's periods either way.
  await db.execute(sql`TRUNCATE TABLE subscription_periods, subscriptions`);
  await db.execute(
    sql`DELETE FROM ledger_accounts WHERE owner_account_id IS NOT NULL`,
  );
  await db.execute(sql`DELETE FROM accounts`);
  // Prices the tests added on top of the seeded opening ones.
  await db.execute(
    sql`DELETE FROM ai_model_prices WHERE effective_from > '1970-01-01T00:00:00Z'`,
  );
  // Settings are seeded by the migration too, but unlike the chart they are
  // knobs the tests turn: put them back where 0043 left them.
  await db.execute(sql`
    UPDATE billing_settings SET value = '30' WHERE key = 'ai_margin_percent'
  `);
  await db.execute(sql`
    UPDATE billing_settings SET value = '"shadow"' WHERE key = 'ai_metering_mode'
  `);
  await db.execute(sql`
    UPDATE billing_settings SET value = '10000000' WHERE key = 'payg_daily_cap_micros'
  `);
  // An account with no subscription prices at the PAYG row's margin (one
  // number — plans.ts says why). The seeded ladder puts PAYG at 100%; these
  // suites were written with worked examples at 30%, so the row is pinned
  // to 30% here and the one test that cares about the seeded value sets it
  // back explicitly.
  await db.execute(sql`
    UPDATE billing_plans SET margin_basis_points = 3000 WHERE code = 'payg'
  `);
}

let counter = 0;

export async function createAccount(): Promise<string> {
  counter += 1;
  const [row] = await db
    .insert(accounts)
    .values({
      displayName: `Ledger Tester ${counter}`,
      primaryEmail: `ledger-${counter}-${Date.now()}@example.com`,
    })
    .returning({ id: accounts.id });
  if (!row) {
    throw new Error("Failed to create a test account");
  }
  return row.id;
}

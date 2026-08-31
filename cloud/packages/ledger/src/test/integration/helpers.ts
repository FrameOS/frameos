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

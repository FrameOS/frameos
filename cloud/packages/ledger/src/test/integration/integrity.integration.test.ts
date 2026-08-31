import { eq, sql } from "drizzle-orm";
import { financialEvents, ledgerAccounts, ledgerBalances } from "@frameos-cloud/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  checkLedgerIntegrity,
  customerCreditsCode,
  dollarsToMicros,
  manualJournalEventType,
  postEvent,
  reverseEntry,
  systemAccountCodes,
} from "../../index";
import { createAccount, db, resetLedger } from "./helpers";

afterAll(async () => {
  await db.$client.end({ timeout: 5 });
});

beforeEach(async () => {
  await resetLedger();
});

async function postPurchase(accountId: string, dollars = 10) {
  return postEvent(db, {
    accountId,
    eventType: manualJournalEventType,
    idempotencyKey: `purchase:${accountId}:${dollars}`,
    payload: {
      description: "Prepaid credit purchase",
      legs: [
        {
          accountCode: systemAccountCodes.pspStripe,
          amountMicros: dollarsToMicros(dollars).toString(),
          direction: "debit",
        },
        {
          accountCode: customerCreditsCode(accountId),
          amountMicros: dollarsToMicros(dollars).toString(),
          direction: "credit",
        },
      ],
    },
    source: "admin",
  });
}

async function accountIdFor(code: string): Promise<string> {
  const [row] = await db
    .select({ id: ledgerAccounts.id })
    .from(ledgerAccounts)
    .where(eq(ledgerAccounts.code, code));
  if (!row) {
    throw new Error(`No ledger account ${code}`);
  }
  return row.id;
}

describe("ledger integrity", () => {
  it("finds nothing wrong with books the kernel wrote", async () => {
    const accountId = await createAccount();
    const posted = await postPurchase(accountId);
    await reverseEntry(db, {
      accountId,
      entryId: posted.entries[0]!.id,
      reason: "Chargeback",
      source: "admin",
    });

    expect(await checkLedgerIntegrity(db)).toEqual([]);
  });

  it("catches a balance cache that drifted from the postings", async () => {
    const accountId = await createAccount();
    await postPurchase(accountId);

    await db
      .update(ledgerBalances)
      .set({ balanceMicros: 999n })
      .where(
        eq(
          ledgerBalances.ledgerAccountId,
          await accountIdFor(systemAccountCodes.pspStripe),
        ),
      );

    const violations = await checkLedgerIntegrity(db);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.check).toBe("balance_cache");
    expect(violations[0]?.detail).toContain(systemAccountCodes.pspStripe);
  });

  // Postings written by anything but the kernel are exactly what these
  // checks exist to catch, so the test writes them the way a bug would.
  it("catches an entry whose legs do not balance", async () => {
    const accountId = await createAccount();
    const posted = await postPurchase(accountId);
    await db.execute(sql`
      insert into ledger_postings (entry_id, ledger_account_id, direction, amount_micros)
      values (${posted.entries[0]!.id}::uuid,
              ${await accountIdFor(systemAccountCodes.revenueAiUsage)}::uuid,
              'credit', 1000)
    `);

    const checks = (await checkLedgerIntegrity(db)).map(
      (violation) => violation.check,
    );
    expect(checks).toContain("entries_balance");
    expect(checks).toContain("accounting_equation");
  });

  it("catches a reversal that does not mirror its target", async () => {
    const accountId = await createAccount();
    const posted = await postPurchase(accountId);
    const reversal = await reverseEntry(db, {
      accountId,
      entryId: posted.entries[0]!.id,
      reason: "Chargeback",
      source: "admin",
    });

    // Balanced legs, so only the mirror check can see this: the reversal now
    // touches an account the original never did.
    const revenueId = await accountIdFor(systemAccountCodes.revenueAiUsage);
    const feesId = await accountIdFor(systemAccountCodes.pspFees);
    await db.execute(sql`
      insert into ledger_postings (entry_id, ledger_account_id, direction, amount_micros)
      values (${reversal.entries[0]!.id}::uuid, ${revenueId}::uuid, 'credit', 5000),
             (${reversal.entries[0]!.id}::uuid, ${feesId}::uuid, 'debit', 5000)
    `);

    const violations = await checkLedgerIntegrity(db);
    // The injected legs also leave two balance caches behind; the mirror
    // check is the one that could only fire for this.
    expect(violations.map((violation) => violation.check)).toContain(
      "reversals_mirror",
    );
    expect(
      violations.filter((violation) => violation.check === "entries_balance"),
    ).toEqual([]);
  });

  it("catches an event that was never posted", async () => {
    await db.insert(financialEvents).values({
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
      eventType: manualJournalEventType,
      idempotencyKey: "stranded:1",
      occurredAt: new Date(Date.now() - 60 * 60 * 1000),
      payload: {},
      source: "cron",
    });

    const violations = await checkLedgerIntegrity(db);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.check).toBe("events_posted_once");
    // Still inside the grace period, so a sweep that is merely in flight
    // does not page anyone.
    expect(
      await checkLedgerIntegrity(db, { pendingEventGraceMs: 24 * 60 * 60 * 1000 }),
    ).toEqual([]);
  });

  it("catches a customer who spent further than the overdraft allows", async () => {
    const accountId = await createAccount();
    await postEvent(db, {
      accountId,
      eventType: manualJournalEventType,
      idempotencyKey: "spend:1",
      payload: {
        description: "A turn billed against an empty balance",
        legs: [
          {
            accountCode: customerCreditsCode(accountId),
            amountMicros: "575120",
            direction: "debit",
          },
          {
            accountCode: systemAccountCodes.revenueAiUsage,
            amountMicros: "575120",
            direction: "credit",
          },
        ],
      },
      source: "admin",
    });

    const violations = await checkLedgerIntegrity(db);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.check).toBe("customer_credit_floor");
    // A dollar of overdraft is policy, not a violation.
    expect(
      await checkLedgerIntegrity(db, { overdraftMicros: 1_000_000n }),
    ).toEqual([]);
  });

  it("notices when the append-only triggers are gone", async () => {
    await db.execute(
      sql`drop trigger "ledger_postings_immutable" on "ledger_postings"`,
    );
    try {
      const violations = await checkLedgerIntegrity(db);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.check).toBe("immutability_triggers");
      expect(violations[0]?.detail).toContain("ledger_postings_immutable");
    } finally {
      await db.execute(sql`
        create trigger "ledger_postings_immutable"
          before update or delete on "ledger_postings"
          for each row execute function "ledger_rows_are_immutable"()
      `);
    }
  });
});

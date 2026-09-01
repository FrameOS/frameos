import { eq } from "drizzle-orm";
import { subscriptionPeriods, subscriptions } from "@frameos-cloud/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  accountAiUsage,
  billingSettingKeys,
  cancelAccountPlan,
  checkLedgerIntegrity,
  customerReceivableCode,
  accountBalanceMicros,
  formatMicros,
  listJournalEntries,
  readAccountPlan,
  recordAiUsage,
  refundUnearnedPeriod,
  runSubscriptionCycle,
  setAccountPlan,
  systemAccountCodes,
  utcMonthWindow,
  writeBillingSetting,
  type JournalEntry,
} from "../../index";
import { createAccount, db, resetLedger } from "./helpers";

afterAll(async () => {
  await db.$client.end({ timeout: 5 });
});

beforeEach(async () => {
  await resetLedger();
});

function anonymize(code: string): string {
  return code.replace(/customer:[0-9a-f-]{36}/i, "customer:<id>");
}

function renderJournal(entries: JournalEntry[]): string {
  return entries
    .slice()
    .reverse()
    .map((entry) => {
      const legs = entry.postings
        .map(
          (posting) =>
            `    ${posting.direction === "debit" ? "Dr" : "Cr"} ${anonymize(posting.accountCode).padEnd(34)} ${formatMicros(posting.amountMicros)}`,
        )
        .join("\n");
      return `  ${entry.entryType}\n${legs}`;
    })
    .join("\n");
}

const turnUsage = {
  cachedInputTokens: 12_000,
  inputTokens: 52_000,
  outputTokens: 30_000,
  reasoningTokens: 8_000,
};

// The postpay + subscription golden file (cloud/docs/accounting-todo.md §3.6):
// a customer subscribes, the cycle charges and recognizes the period, their
// metered turns price at the PLAN's margin rather than the deployment's, and
// everything lands on the one receivable a month-end invoice would collect.
describe("a subscriber's life through the books", () => {
  it("charges, recognizes and meters at the plan's margin, all on one receivable", async () => {
    const accountId = await createAccount();
    await writeBillingSetting(db, billingSettingKeys.aiMeteringMode, "live");
    const receivable = customerReceivableCode(accountId);

    // 1. They take the Maker plan: $1.99/month, and AI at 50% margin instead
    //    of the deployment's 30%.
    await setAccountPlan(db, accountId, "maker");
    const plan = await readAccountPlan(db, accountId);
    expect(plan.plan.code).toBe("maker");
    expect(plan.plan.marginBasisPoints).toBe(5_000);
    expect(plan.subscribed).toBe(true);

    // 2. The nightly cycle opens the period and charges it. The charge is an
    //    accrual, not a payment: it lands on the receivable next to their
    //    metered usage, which is the whole reason postpay came first.
    const opened = await runSubscriptionCycle(db);
    expect(opened.opened).toBe(1);
    expect(opened.charged).toBe(1);
    expect(opened.recognized).toBe(0);
    expect(opened.failures).toEqual([]);
    expect(await accountBalanceMicros(db, receivable)).toBe(1_990_000n);
    // Not revenue yet: they have paid for a month we have not served.
    expect(
      await accountBalanceMicros(db, systemAccountCodes.deferredSubscriptions),
    ).toBe(1_990_000n);
    expect(
      await accountBalanceMicros(db, systemAccountCodes.revenueSubscriptions),
    ).toBe(0n);

    // 3. Running again the same night charges nobody twice. This is the one
    //    property the nightly job's whole design rests on.
    const again = await runSubscriptionCycle(db);
    expect(again).toMatchObject({ charged: 0, opened: 0, recognized: 0 });
    expect(await accountBalanceMicros(db, receivable)).toBe(1_990_000n);

    // 4. A metered turn, priced at the PLAN's 50% and not the global 30%.
    //    442,400 provider cost × 1.5 = 663,600.
    await recordAiUsage(db, {
      accountId,
      credentialSource: "platform",
      model: "gpt-5.6-terra",
      surface: "scene_chat",
      turnId: "00000000-0000-4000-8000-0000000000b1",
      usage: turnUsage,
    });
    expect(await accountBalanceMicros(db, receivable)).toBe(1_990_000n + 663_600n);
    expect(
      await accountBalanceMicros(db, systemAccountCodes.revenueAiUsage),
    ).toBe(663_600n);

    // The customer's own view agrees with the books, which is §5.2's point:
    // the page and the ledger are one query apart, not two definitions apart.
    const mine = await accountAiUsage(db, accountId, utcMonthWindow(new Date()));
    expect(mine.chargeableMicros).toBe(663_600n);
    expect(mine.turns).toBe(1);

    expect("\n" + renderJournal(await listJournalEntries(db, { limit: 100 }))).toBe(`
  subscription_charge
    Dr asset:receivable:customer:<id>     1.990000
    Cr liability:deferred:subscriptions   1.990000
  ai_usage_charge
    Dr asset:receivable:customer:<id>     0.663600
    Cr revenue:ai_usage                   0.663600
  ai_usage_cost
    Dr expense:cogs:openai                0.442400
    Cr liability:accrued:openai           0.442400`);

    expect(await checkLedgerIntegrity(db, { pendingEventGraceMs: 0 })).toEqual([]);
  });

  it("recognizes the period once it has actually been served", async () => {
    const accountId = await createAccount();
    await setAccountPlan(db, accountId, "maker");
    await runSubscriptionCycle(db);

    // Nothing is earned until the period ends, however many nights run.
    await runSubscriptionCycle(db);
    expect(
      await accountBalanceMicros(db, systemAccountCodes.revenueSubscriptions),
    ).toBe(0n);

    // Two months on, the first period is over and a second has opened.
    const later = new Date(Date.now() + 40 * 24 * 60 * 60 * 1000);
    const result = await runSubscriptionCycle(db, { now: later });
    expect(result.recognized).toBe(1);
    expect(
      await accountBalanceMicros(db, systemAccountCodes.revenueSubscriptions),
    ).toBe(1_990_000n);
    expect(await checkLedgerIntegrity(db, { pendingEventGraceMs: 0 })).toEqual([]);
  });

  it("returns the unearned remainder to the receivable rather than to cash", async () => {
    const accountId = await createAccount();
    await setAccountPlan(db, accountId, "studio");
    await runSubscriptionCycle(db);
    const receivable = customerReceivableCode(accountId);
    expect(await accountBalanceMicros(db, receivable)).toBe(6_990_000n);

    const [period] = await db.select().from(subscriptionPeriods);
    // Half the month unearned: it nets against what they owe, which under
    // postpay is usually the entire answer — no cash leaves.
    await refundUnearnedPeriod(db, period!, 3_495_000n);
    expect(await accountBalanceMicros(db, receivable)).toBe(3_495_000n);
    expect(
      await accountBalanceMicros(db, systemAccountCodes.deferredSubscriptions),
    ).toBe(3_495_000n);
    expect(
      await accountBalanceMicros(db, systemAccountCodes.refundsPayable),
    ).toBe(0n);
    expect(await checkLedgerIntegrity(db, { pendingEventGraceMs: 0 })).toEqual([]);
  });

  it("runs a cancelled plan to the end of the period it was paid for", async () => {
    const accountId = await createAccount();
    await setAccountPlan(db, accountId, "maker");
    await runSubscriptionCycle(db);

    await cancelAccountPlan(db, accountId);
    const [row] = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.accountId, accountId));
    expect(row?.status).toBe("canceling");
    // Still theirs: they paid for this month.
    expect((await readAccountPlan(db, accountId)).plan.code).toBe("maker");

    // Past the period end, the entitlement is gone and nothing new is
    // charged — the plan expires on time whether or not the job has run.
    const later = new Date(Date.now() + 40 * 24 * 60 * 60 * 1000);
    const cycle = await runSubscriptionCycle(db, { now: later });
    expect(cycle.opened).toBe(0);
    expect(cycle.charged).toBe(0);
    expect((await readAccountPlan(db, accountId)).plan.code).toBe("payg");
  });

  it("puts an account with no subscription on the free plan", async () => {
    const accountId = await createAccount();
    const plan = await readAccountPlan(db, accountId);
    expect(plan.plan.code).toBe("payg");
    expect(plan.subscribed).toBe(false);
    // And opens no period for it: a $0 charge is not an entry worth posting.
    expect(await runSubscriptionCycle(db)).toMatchObject({ charged: 0, opened: 0 });
    expect(await db.select().from(subscriptionPeriods)).toHaveLength(0);
  });
});

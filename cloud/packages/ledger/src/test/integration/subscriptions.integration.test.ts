import { eq, sql } from "drizzle-orm";
import { accounts, subscriptionPeriods, subscriptions } from "@frameos-cloud/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  accountAiUsage,
  accountBalanceMicros,
  billingSettingKeys,
  cancelAccountPlan,
  checkDeferredSubscriptions,
  checkLedgerIntegrity,
  closeOutSubscriptionForDeletedAccount,
  customerReceivableCode,
  formatMicros,
  listJournalEntries,
  readAccountPlan,
  recognizePeriod,
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

const day = 24 * 60 * 60 * 1000;
// A fixed clock for the tests that reason about periods: Jan 10 → Feb 10 is
// 31 days, so half a period is exactly 15.5 days and prorations come out in
// whole micro-dollars.
const t0 = new Date("2026-01-10T00:00:00Z");
const halfway = new Date(t0.getTime() + 15.5 * day);

async function deferred() {
  return accountBalanceMicros(db, systemAccountCodes.deferredSubscriptions);
}

async function periodsFor(accountId: string) {
  const [row] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.accountId, accountId));
  if (!row) {
    return [];
  }
  return db
    .select()
    .from(subscriptionPeriods)
    .where(eq(subscriptionPeriods.subscriptionId, row.id))
    .orderBy(subscriptionPeriods.periodStart);
}

// The postpay + subscription golden file (cloud/docs/accounting-todo.md §3.6):
// a customer subscribes, the period is charged the moment they do, their
// metered turns price at the PLAN's margin rather than PAYG's, and everything
// lands on the one receivable a month-end invoice would collect.
describe("a subscriber's life through the books", () => {
  it("charges on subscribing, recognizes at period end, and meters at the plan's margin", async () => {
    const accountId = await createAccount();
    await writeBillingSetting(db, billingSettingKeys.aiMeteringMode, "live");
    const receivable = customerReceivableCode(accountId);

    // 1. They take the Maker plan: $1.99/month, and AI at 50% margin instead
    //    of PAYG's. The first period opens and charges right here — a plan
    //    taken and cancelled the same afternoon used to cost nothing because
    //    only the nightly job opened periods (§9.2 item 6).
    await setAccountPlan(db, accountId, "maker");
    const plan = await readAccountPlan(db, accountId);
    expect(plan.plan.code).toBe("maker");
    expect(plan.plan.marginBasisPoints).toBe(5_000);
    expect(plan.subscribed).toBe(true);
    expect(await accountBalanceMicros(db, receivable)).toBe(1_990_000n);
    // Not revenue yet: they owe for a month we have not served.
    expect(await deferred()).toBe(1_990_000n);
    expect(
      await accountBalanceMicros(db, systemAccountCodes.revenueSubscriptions),
    ).toBe(0n);

    // 2. The nightly cycle finds nothing to do, however many times it runs.
    //    This is the one property the job's whole design rests on.
    expect(await runSubscriptionCycle(db)).toMatchObject({ charged: 0, opened: 0, recognized: 0 });
    expect(await runSubscriptionCycle(db)).toMatchObject({ charged: 0, opened: 0, recognized: 0 });
    expect(await accountBalanceMicros(db, receivable)).toBe(1_990_000n);

    // 3. A metered turn, priced at the PLAN's 50%: 442,400 × 1.5 = 663,600.
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

    // The customer's own view agrees with the books, which is §5.2's point.
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

  // §9.3: revenue is recognised daily, pro rata by whole days served, so a
  // calendar-month P&L does not lag a month behind the periods. Jan 10 → Feb
  // 10 is 31 days; the second period, Feb 10 → Mar 10, is 28.
  it("earns the period day by day, never twice for the same day, and closes it out at the end", async () => {
    const accountId = await createAccount();
    await setAccountPlan(db, accountId, "maker", { now: t0 });
    const revenue = () =>
      accountBalanceMicros(db, systemAccountCodes.revenueSubscriptions);

    // The night it was taken: nothing served yet, nothing earned.
    expect(await runSubscriptionCycle(db, { now: t0 })).toMatchObject({ accrued: 0, recognized: 0 });
    expect(await revenue()).toBe(0n);

    // Ten days in: 1,990,000 × 10/31 = 641,935.48 → 641,935, and the rest
    // stays deferred.
    const tenDays = new Date(t0.getTime() + 10 * day);
    expect(await runSubscriptionCycle(db, { now: tenDays })).toMatchObject({
      accrued: 1,
      accruedMicros: 641_935n,
      recognized: 0,
    });
    expect(await revenue()).toBe(641_935n);
    expect(await deferred()).toBe(1_990_000n - 641_935n);

    // The same night again, and five hours later: no new whole day, no
    // new entry. This is what lets the job run twice without double-earning.
    expect(await runSubscriptionCycle(db, { now: tenDays })).toMatchObject({ accrued: 0 });
    expect(
      await runSubscriptionCycle(db, { now: new Date(tenDays.getTime() + 5 * 3600 * 1000) }),
    ).toMatchObject({ accrued: 0 });
    expect(await revenue()).toBe(641_935n);

    // Forty days on: the first period is over (its remainder earned and the
    // row closed out) and the second, charged tonight, has served nine of
    // its 28 days: 1,990,000 × 9/28 = 639,642.86 → 639,643.
    const later = new Date(t0.getTime() + 40 * day);
    const result = await runSubscriptionCycle(db, { now: later });
    expect(result).toMatchObject({ charged: 1, opened: 1, recognized: 1 });
    expect(result.accruedMicros).toBe(1_990_000n - 641_935n + 639_643n);
    expect(await revenue()).toBe(1_990_000n + 639_643n);
    expect(await deferred()).toBe(1_990_000n - 639_643n);
    const [first, second] = await periodsFor(accountId);
    expect(first).toMatchObject({ recognizedMicros: 1_990_000n });
    expect(first?.recognizedAt).not.toBeNull();
    expect(second).toMatchObject({ recognizedMicros: 639_643n, recognizedAt: null });
    // The remainder of the first period was booked on its last day, not on
    // the night the job happened to run.
    const closing = (await listJournalEntries(db, { limit: 100 })).filter(
      (entry) =>
        entry.entryType === "subscription_recognition" &&
        entry.postings[0]?.amountMicros === 1_990_000n - 641_935n,
    );
    expect(closing).toHaveLength(1);
    expect(closing[0]?.occurredAt).toEqual(first?.periodEnd);
    expect(await checkLedgerIntegrity(db, { pendingEventGraceMs: 0 })).toEqual([]);
  });

  it("refunds only what the daily accruals have not already earned", async () => {
    const accountId = await createAccount();
    await setAccountPlan(db, accountId, "studio", { now: t0 });
    // Ten days earned: 6,990,000 × 10/31 = 2,254,838.7 → 2,254,839.
    await runSubscriptionCycle(db, { now: new Date(t0.getTime() + 10 * day) });
    const [period] = await periodsFor(accountId);
    expect(period?.recognizedMicros).toBe(2_254_839n);

    // The whole price is no longer refundable from the deferral: part of it
    // is revenue now, and that needs a reversal, not a refund.
    await expect(refundUnearnedPeriod(db, period!, 6_990_000n)).rejects.toThrow(/no larger than/);
    const left = 6_990_000n - 2_254_839n;
    await refundUnearnedPeriod(db, period!, left);
    expect(await deferred()).toBe(0n);

    // Nothing more to earn, tonight or at the end.
    const [refunded] = await periodsFor(accountId);
    expect(await runSubscriptionCycle(db, { now: new Date(t0.getTime() + 20 * day) })).toMatchObject({ accrued: 0 });
    await recognizePeriod(db, refunded!);
    expect(
      await accountBalanceMicros(db, systemAccountCodes.revenueSubscriptions),
    ).toBe(2_254_839n);
    expect(await checkLedgerIntegrity(db, { pendingEventGraceMs: 0 })).toEqual([]);
  });

  it("returns the unearned remainder to the receivable, and then earns only the rest", async () => {
    const accountId = await createAccount();
    await setAccountPlan(db, accountId, "studio");
    const receivable = customerReceivableCode(accountId);
    expect(await accountBalanceMicros(db, receivable)).toBe(6_990_000n);

    const [period] = await periodsFor(accountId);
    // Half the month unearned: it nets against what they owe, which under
    // postpay is usually the entire answer — no cash leaves.
    await refundUnearnedPeriod(db, period!, 3_495_000n);
    expect(await accountBalanceMicros(db, receivable)).toBe(3_495_000n);
    expect(await deferred()).toBe(3_495_000n);
    expect(
      await accountBalanceMicros(db, systemAccountCodes.refundsPayable),
    ).toBe(0n);

    // A second refund cannot exceed what is still deferred.
    const [refunded] = await periodsFor(accountId);
    await expect(refundUnearnedPeriod(db, refunded!, 3_495_001n)).rejects.toThrow(
      /no larger than/,
    );

    // Recognition earns the half that was served, not the full price — the
    // full price would have driven the deferred account $3.50 negative.
    await recognizePeriod(db, refunded!);
    expect(
      await accountBalanceMicros(db, systemAccountCodes.revenueSubscriptions),
    ).toBe(3_495_000n);
    expect(await deferred()).toBe(0n);
    expect(await checkLedgerIntegrity(db, { pendingEventGraceMs: 0 })).toEqual([]);
  });

  it("runs a cancelled plan to the end of the period it was charged for", async () => {
    const accountId = await createAccount();
    await setAccountPlan(db, accountId, "maker");

    await cancelAccountPlan(db, accountId);
    const [row] = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.accountId, accountId));
    expect(row?.status).toBe("canceling");
    // Still theirs: they owe for this month, and it was charged already.
    expect((await readAccountPlan(db, accountId)).plan.code).toBe("maker");
    expect(await accountBalanceMicros(db, customerReceivableCode(accountId))).toBe(1_990_000n);

    // Past the period end, the entitlement is gone and nothing new is
    // charged — the plan expires on time whether or not the job has run.
    const later = new Date(Date.now() + 40 * day);
    const cycle = await runSubscriptionCycle(db, { now: later });
    expect(cycle.opened).toBe(0);
    expect(cycle.charged).toBe(0);
    expect((await readAccountPlan(db, accountId)).plan.code).toBe("payg");
  });

  // §9.2 item 2: the catch-up used to start from the last period's end even
  // across a cancellation, so a return six months later was billed for six
  // months nobody was subscribed for.
  it("does not bill the gap between a cancellation and a return", async () => {
    const accountId = await createAccount();
    const receivable = customerReceivableCode(accountId);
    await setAccountPlan(db, accountId, "maker", { now: t0 });
    await cancelAccountPlan(db, accountId, { immediately: true, now: new Date(t0.getTime() + day) });
    expect(await accountBalanceMicros(db, receivable)).toBe(1_990_000n);

    const back = new Date(t0.getTime() + 200 * day);
    await setAccountPlan(db, accountId, "studio", { now: back });
    const periods = await periodsFor(accountId);
    expect(periods.map((period) => period.planCode)).toEqual(["maker", "studio"]);
    expect(periods[1]?.periodStart).toEqual(back);
    // One Maker month and one Studio month: nothing in between.
    expect(await accountBalanceMicros(db, receivable)).toBe(1_990_000n + 6_990_000n);
    expect(await runSubscriptionCycle(db, { now: back })).toMatchObject({ charged: 0, opened: 0 });
    expect(await checkLedgerIntegrity(db, { pendingEventGraceMs: 0 })).toEqual([]);
  });

  // §9.2 item 6: an upgrade is reverse-and-rebook, prorated. The unearned
  // half of the Maker month comes back to the receivable, the Maker period
  // ends now, and a Studio period starts now at Studio's price and margin.
  it("prorates an upgrade and starts the new plan at once", async () => {
    const accountId = await createAccount();
    const receivable = customerReceivableCode(accountId);
    await setAccountPlan(db, accountId, "maker", { now: t0 });
    await setAccountPlan(db, accountId, "studio", { now: halfway });

    expect((await readAccountPlan(db, accountId)).plan.code).toBe("studio");
    const periods = await periodsFor(accountId);
    expect(periods).toHaveLength(2);
    expect(periods[0]).toMatchObject({ planCode: "maker", refundedMicros: 995_000n });
    expect(periods[0]?.periodEnd).toEqual(halfway);
    expect(periods[1]).toMatchObject({ planCode: "studio", priceMicros: 6_990_000n });
    expect(periods[1]?.periodStart).toEqual(halfway);
    // Owed: the served half of Maker plus the whole Studio month.
    expect(await accountBalanceMicros(db, receivable)).toBe(995_000n + 6_990_000n);
    expect(await deferred()).toBe(995_000n + 6_990_000n);

    // The next cycle recognizes the Maker half that was served, no more —
    // and a minute into the Studio period is not a whole day, so nothing of
    // it is earned yet.
    const cycle = await runSubscriptionCycle(db, { now: new Date(halfway.getTime() + 60_000) });
    expect(cycle).toMatchObject({ charged: 0, opened: 0, recognized: 1 });
    expect(
      await accountBalanceMicros(db, systemAccountCodes.revenueSubscriptions),
    ).toBe(995_000n);
    expect(await deferred()).toBe(6_990_000n);
    expect(await checkLedgerIntegrity(db, { pendingEventGraceMs: 0 })).toEqual([]);
  });

  it("applies a downgrade at the rollover, not before", async () => {
    const accountId = await createAccount();
    const receivable = customerReceivableCode(accountId);
    await setAccountPlan(db, accountId, "studio", { now: t0 });
    await setAccountPlan(db, accountId, "maker", { now: new Date(t0.getTime() + 5 * day) });

    // They keep what they paid for until the period ends.
    const during = await readAccountPlan(db, accountId);
    expect(during.plan.code).toBe("studio");
    expect(during.nextPlanCode).toBe("maker");
    expect(await accountBalanceMicros(db, receivable)).toBe(6_990_000n);

    const cycle = await runSubscriptionCycle(db, { now: new Date(t0.getTime() + 35 * day) });
    expect(cycle).toMatchObject({ charged: 1, opened: 1, recognized: 1 });
    const after = await readAccountPlan(db, accountId);
    expect(after.plan.code).toBe("maker");
    expect(after.nextPlanCode).toBeNull();
    expect((await periodsFor(accountId)).map((period) => period.planCode)).toEqual(["studio", "maker"]);
    expect(await accountBalanceMicros(db, receivable)).toBe(6_990_000n + 1_990_000n);
    expect(await checkLedgerIntegrity(db, { pendingEventGraceMs: 0 })).toEqual([]);
  });

  // §9.2 item 4: deleting a subscriber used to cascade the charged period
  // away and strand its deferred revenue. Now erasure closes the books out
  // first, the subscription row survives (a bare uuid, like every ledger
  // row), and the deferred-revenue invariant is what would notice if it
  // ever went wrong again.
  it("closes a subscription out when the account is erased, and the books stay whole", async () => {
    const accountId = await createAccount();
    const receivable = customerReceivableCode(accountId);
    await setAccountPlan(db, accountId, "maker", { now: t0 });

    await closeOutSubscriptionForDeletedAccount(db, accountId, { now: halfway });
    await db.delete(accounts).where(eq(accounts.id, accountId));

    const [row] = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.accountId, accountId));
    expect(row?.status).toBe("canceled");
    expect((await periodsFor(accountId))[0]).toMatchObject({ refundedMicros: 995_000n });
    // The served half is still owed; the unearned half came back.
    expect(await accountBalanceMicros(db, receivable)).toBe(995_000n);
    expect(await deferred()).toBe(995_000n);
    expect(await checkDeferredSubscriptions(db)).toEqual([]);

    // What the old cascade did, by hand: the period row vanishes and the
    // deferred balance is orphaned. The invariant says so.
    await db.execute(sql`delete from subscription_periods`);
    const violations = await checkDeferredSubscriptions(db);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.detail).toContain("995000");
  });

  it("puts an account with no subscription on the free plan, at the PAYG row's margin", async () => {
    const accountId = await createAccount();
    const plan = await readAccountPlan(db, accountId);
    expect(plan.plan.code).toBe("payg");
    expect(plan.subscribed).toBe(false);
    // And opens no period for it: a $0 charge is not an entry worth posting.
    expect(await runSubscriptionCycle(db)).toMatchObject({ charged: 0, opened: 0 });
    expect(await db.select().from(subscriptionPeriods)).toHaveLength(0);

    // One margin definition (§9.2 item 5): the PAYG row's, not the global
    // setting's. The helper pins the row to 30% for the other suites; this
    // is the seeded 100%.
    await db.execute(sql`update billing_plans set margin_basis_points = 10000 where code = 'payg'`);
    const metered = await recordAiUsage(db, {
      accountId,
      credentialSource: "platform",
      model: "gpt-5.6-terra",
      surface: "scene_chat",
      turnId: "00000000-0000-4000-8000-0000000000b2",
      usage: turnUsage,
    });
    expect(metered.record.priceMicros).toBe(884_800n);
  });
});

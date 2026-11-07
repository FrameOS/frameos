import { eq } from "drizzle-orm";
import { providerPayments, subscriptionPeriods, subscriptions } from "@frameos-cloud/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  accountBalanceMicros,
  applyProviderFee,
  applyProviderPayment,
  applyProviderRefund,
  checkLedgerIntegrity,
  closeOutSubscriptionForDeletedAccount,
  customerReceivableCode,
  readAccountPlan,
  runSubscriptionCycle,
  setAccountPlan,
  setProviderSubscriptionState,
  systemAccountCodes,
  type ProviderPaymentInput,
} from "../../index";
import { createAccount, db, resetLedger } from "./helpers";

afterAll(async () => {
  await db.$client.end({ timeout: 5 });
});

beforeEach(async () => {
  await resetLedger();
});

// The seeded ladder: maker $1.99, studio $6.99.
const maker = 1_990_000n;
const studio = 6_990_000n;

const day = 24 * 60 * 60 * 1000;
const start = new Date("2026-11-05T10:00:00.000Z");
const nextMonth = new Date("2026-12-05T10:00:00.000Z");
const monthAfter = new Date("2027-01-05T10:00:00.000Z");

function payment(
  accountId: string,
  overrides: Partial<ProviderPaymentInput> = {},
): ProviderPaymentInput {
  return {
    accountId,
    amountMicros: maker,
    mode: "live",
    periodEnd: nextMonth,
    periodStart: start,
    planCode: "maker",
    post: true,
    provider: "psp",
    subscriptionId: "sub_1",
    transactionId: "tran_1",
    ...overrides,
  };
}

async function balances(accountId: string) {
  return {
    deferred: await accountBalanceMicros(db, systemAccountCodes.deferredSubscriptions),
    psp: await accountBalanceMicros(db, systemAccountCodes.psp),
    receivable: await accountBalanceMicros(db, customerReceivableCode(accountId)),
    revenue: await accountBalanceMicros(db, systemAccountCodes.revenueSubscriptions),
  };
}

async function periodsOf(accountId: string) {
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

async function expectBooksToHold() {
  expect(await checkLedgerIntegrity(db)).toEqual([]);
}

describe("subscriptions a payment provider bills", () => {
  it("opens a paid period with the provider's bounds, and owes nothing", async () => {
    const accountId = await createAccount();
    const result = await applyProviderPayment(db, payment(accountId), { now: start });

    expect(result.applied).toBe(true);
    expect((await readAccountPlan(db, accountId)).plan.code).toBe("maker");
    const [period] = await periodsOf(accountId);
    expect(period?.periodStart.toISOString()).toBe(start.toISOString());
    expect(period?.periodEnd.toISOString()).toBe(nextMonth.toISOString());
    expect(period?.priceMicros).toBe(maker);
    expect(await balances(accountId)).toEqual({
      deferred: maker,
      psp: maker,
      receivable: 0n,
      revenue: 0n,
    });
    await expectBooksToHold();
  });

  it("applies a transaction once, however often it is reported", async () => {
    const accountId = await createAccount();
    await applyProviderPayment(db, payment(accountId), { now: start });
    const again = await applyProviderPayment(db, payment(accountId), { now: start });

    expect(again.applied).toBe(false);
    expect(await periodsOf(accountId)).toHaveLength(1);
    expect((await balances(accountId)).psp).toBe(maker);
  });

  it("leaves the next period to the provider, not to the nightly cycle", async () => {
    const accountId = await createAccount();
    await applyProviderPayment(db, payment(accountId), { now: start });

    // Two days past the period end with no renewal reported: nothing opens,
    // nothing lands on the receivable, the paid month is earned in full.
    const late = new Date(nextMonth.getTime() + 2 * day);
    const cycle = await runSubscriptionCycle(db, { now: late });
    expect(cycle.opened).toBe(0);
    expect(await periodsOf(accountId)).toHaveLength(1);
    expect(await balances(accountId)).toEqual({
      deferred: 0n,
      psp: maker,
      receivable: 0n,
      revenue: maker,
    });

    // The renewal arrives: the next period starts where the last one ended.
    await applyProviderPayment(
      db,
      payment(accountId, {
        periodEnd: monthAfter,
        periodStart: nextMonth,
        transactionId: "tran_2",
      }),
      { now: late },
    );
    const periods = await periodsOf(accountId);
    expect(periods).toHaveLength(2);
    expect(periods[1]?.periodStart.toISOString()).toBe(nextMonth.toISOString());
    expect((await balances(accountId)).receivable).toBe(0n);
    await expectBooksToHold();
  });

  it("carries the unearned rest of a period into an upgrade", async () => {
    const accountId = await createAccount();
    await applyProviderPayment(db, payment(accountId), { now: start });

    // Halfway through the 30 days, the provider charges a prorated $2.50
    // for the dearer plan and keeps the billing date.
    const halfway = new Date(start.getTime() + 15 * day);
    const prorated = 2_500_000n;
    await applyProviderPayment(
      db,
      payment(accountId, {
        amountMicros: prorated,
        planCode: "studio",
        transactionId: "tran_upgrade",
      }),
      { now: halfway },
    );

    expect((await readAccountPlan(db, accountId)).plan.code).toBe("studio");
    const periods = await periodsOf(accountId);
    expect(periods).toHaveLength(2);
    expect(periods[0]?.periodEnd.toISOString()).toBe(halfway.toISOString());
    expect(periods[0]?.refundedMicros).toBe(maker / 2n);
    expect(periods[1]?.periodStart.toISOString()).toBe(halfway.toISOString());
    expect(periods[1]?.periodEnd.toISOString()).toBe(nextMonth.toISOString());
    expect(periods[1]?.priceMicros).toBe(maker / 2n + prorated);
    // Everything collected is either deferred or about to be earned, and
    // the customer owes nothing.
    const after = await balances(accountId);
    expect(after.receivable).toBe(0n);
    expect(after.psp).toBe(maker + prorated);
    expect(after.deferred).toBe(maker + prorated);

    await runSubscriptionCycle(db, { now: new Date(nextMonth.getTime() + day) });
    expect(await balances(accountId)).toEqual({
      deferred: 0n,
      psp: maker + prorated,
      receivable: 0n,
      revenue: maker + prorated,
    });
    await expectBooksToHold();
    expect(studio).toBeGreaterThan(maker);
  });

  it("grants the plan and posts nothing for a fully discounted period", async () => {
    const accountId = await createAccount();
    await applyProviderPayment(db, payment(accountId, { amountMicros: 0n }), { now: start });

    expect((await readAccountPlan(db, accountId)).plan.code).toBe("maker");
    expect(await balances(accountId)).toEqual({
      deferred: 0n,
      psp: 0n,
      receivable: 0n,
      revenue: 0n,
    });
    await runSubscriptionCycle(db, { now: new Date(start.getTime() + 3 * day) });
    await expectBooksToHold();
  });

  it("records a test-mode payment and keeps it out of the books", async () => {
    const accountId = await createAccount();
    await applyProviderPayment(db, payment(accountId, { mode: "test", post: false }), {
      now: start,
    });

    expect((await readAccountPlan(db, accountId)).plan.code).toBe("maker");
    const [row] = await db.select().from(providerPayments);
    expect(row?.amountMicros).toBe(maker);
    expect(row?.posted).toBe(false);
    expect(await balances(accountId)).toEqual({
      deferred: 0n,
      psp: 0n,
      receivable: 0n,
      revenue: 0n,
    });
    await expectBooksToHold();
  });

  it("takes a refund out of the deferral first, then out of revenue", async () => {
    const accountId = await createAccount();
    await applyProviderPayment(db, payment(accountId), { now: start });
    // Ten of thirty days served and earned.
    const tenDays = new Date(start.getTime() + 10 * day);
    await runSubscriptionCycle(db, { now: tenDays });
    const earned = (await balances(accountId)).revenue;
    expect(earned).toBeGreaterThan(0n);

    await applyProviderRefund(
      db,
      {
        accountId,
        amountMicros: maker,
        mode: "live",
        paymentTransactionId: "tran_1",
        post: true,
        provider: "psp",
        refundId: "ref_1",
      },
      { now: tenDays },
    );
    expect(await balances(accountId)).toEqual({
      deferred: 0n,
      psp: 0n,
      receivable: 0n,
      revenue: 0n,
    });
    // Once per refund id.
    const again = await applyProviderRefund(
      db,
      {
        accountId,
        amountMicros: maker,
        mode: "live",
        paymentTransactionId: "tran_1",
        post: true,
        provider: "psp",
        refundId: "ref_1",
      },
      { now: tenDays },
    );
    expect(again.applied).toBe(false);
    await runSubscriptionCycle(db, { now: new Date(nextMonth.getTime() + day) });
    expect((await balances(accountId)).revenue).toBe(0n);
    await expectBooksToHold();
  });

  it("refuses a refund for a payment the books never saw", async () => {
    const accountId = await createAccount();
    await expect(
      applyProviderRefund(db, {
        accountId,
        amountMicros: maker,
        mode: "live",
        paymentTransactionId: "tran_unknown",
        post: true,
        provider: "psp",
        refundId: "ref_2",
      }),
    ).rejects.toThrow(/books do not hold/);
  });

  it("follows a scheduled cancellation, its withdrawal, and the end", async () => {
    const accountId = await createAccount();
    await applyProviderPayment(db, payment(accountId), { now: start });
    const soon = new Date(start.getTime() + day);

    await setProviderSubscriptionState(db, accountId, "psp", { kind: "scheduled" }, { now: soon });
    let plan = await readAccountPlan(db, accountId);
    expect(plan.status).toBe("canceling");
    expect(plan.cancelAt?.toISOString()).toBe(nextMonth.toISOString());
    expect(plan.plan.code).toBe("maker");

    await setProviderSubscriptionState(db, accountId, "psp", { kind: "active" }, { now: soon });
    plan = await readAccountPlan(db, accountId);
    expect(plan.status).toBe("active");
    expect(plan.cancelAt).toBeNull();

    await setProviderSubscriptionState(db, accountId, "psp", { kind: "canceled" }, { now: soon });
    expect((await readAccountPlan(db, accountId)).plan.code).toBe("payg");
    // The month was paid for and is not handed back: it is earned to its end.
    await runSubscriptionCycle(db, { now: new Date(nextMonth.getTime() + day) });
    expect(await balances(accountId)).toEqual({
      deferred: 0n,
      psp: maker,
      receivable: 0n,
      revenue: maker,
    });
    await expectBooksToHold();
  });

  it("does not let an operator's plan change bill a provider subscription twice", async () => {
    const accountId = await createAccount();
    await applyProviderPayment(db, payment(accountId), { now: start });
    await expect(
      setAccountPlan(db, accountId, "studio", { now: new Date(start.getTime() + day) }),
    ).rejects.toThrow(/billed through psp/);
  });

  it("keeps a paid period when the account is deleted", async () => {
    const accountId = await createAccount();
    await applyProviderPayment(db, payment(accountId), { now: start });
    await closeOutSubscriptionForDeletedAccount(db, accountId, {
      now: new Date(start.getTime() + 5 * day),
    });

    expect((await readAccountPlan(db, accountId)).plan.code).toBe("payg");
    expect((await balances(accountId)).receivable).toBe(0n);
    await runSubscriptionCycle(db, { now: new Date(nextMonth.getTime() + day) });
    expect((await balances(accountId)).revenue).toBe(maker);
    await expectBooksToHold();
  });

  it("leaves a plan set by hand alone when the provider reports a cancellation", async () => {
    const accountId = await createAccount();
    await setAccountPlan(db, accountId, "maker", { now: start });
    await setProviderSubscriptionState(db, accountId, "psp", { kind: "canceled" }, { now: start });
    expect((await readAccountPlan(db, accountId)).plan.code).toBe("maker");
  });
});

// Stripe is a payment processor, not a merchant of record: the VAT it adds
// lands in our balance and is owed to the tax authority, and its fee comes
// out of every charge (migration 0075, rules/payment.ts).
describe("a provider that leaves the tax and its fee with us", () => {
  const tax = 417_900n; // 21% of $1.99

  async function owed() {
    return {
      fees: await accountBalanceMicros(db, systemAccountCodes.pspFees),
      psp: await accountBalanceMicros(db, systemAccountCodes.psp),
      salesTax: await accountBalanceMicros(db, systemAccountCodes.salesTax),
    };
  }

  it("books the VAT it collected as owed, apart from the price", async () => {
    const accountId = await createAccount();
    await applyProviderPayment(db, payment(accountId, { taxMicros: tax, taxRemittedBy: "us" }), {
      now: start,
    });
    expect(await owed()).toEqual({ fees: 0n, psp: maker + tax, salesTax: tax });
    const view = await balances(accountId);
    expect(view.deferred).toBe(maker);
    expect(view.receivable).toBe(0n);
    const [row] = await db.select().from(providerPayments);
    expect(row?.taxRemittedBy).toBe("us");
    await expectBooksToHold();
  });

  it("leaves a merchant of record's tax out of the books", async () => {
    const accountId = await createAccount();
    await applyProviderPayment(db, payment(accountId, { taxMicros: tax }), { now: start });
    expect(await owed()).toEqual({ fees: 0n, psp: maker, salesTax: 0n });
    await expectBooksToHold();
  });

  it("hands the VAT back with a refund, as the payment booked it", async () => {
    const accountId = await createAccount();
    await applyProviderPayment(db, payment(accountId, { taxMicros: tax, taxRemittedBy: "us" }), {
      now: start,
    });
    await applyProviderRefund(
      db,
      {
        accountId,
        amountMicros: maker,
        mode: "live",
        paymentTransactionId: "tran_1",
        post: true,
        provider: "psp",
        refundId: "ref_1",
        taxMicros: tax,
      },
      { now: new Date(start.getTime() + day) },
    );
    expect(await owed()).toEqual({ fees: 0n, psp: 0n, salesTax: 0n });
    const [refund] = await db.select().from(providerPayments).where(eq(providerPayments.kind, "refund"));
    expect(refund?.taxRemittedBy).toBe("us");
    await expectBooksToHold();
  });

  it("books the provider's fee as a cost, once per fee", async () => {
    const accountId = await createAccount();
    await applyProviderPayment(db, payment(accountId), { now: start });
    const fee = {
      accountId,
      amountMicros: 358_000n,
      details: { settlement: { amount_minor: 33, currency: "EUR", exchange_rate: 0.92 } },
      feeId: "txn_1",
      mode: "live" as const,
      paymentRef: "ch_1",
      planCode: "maker",
      post: true,
      provider: "psp",
    };
    expect((await applyProviderFee(db, fee, { now: start })).applied).toBe(true);
    expect((await applyProviderFee(db, fee, { now: start })).applied).toBe(false);
    expect(await owed()).toEqual({ fees: 358_000n, psp: maker - 358_000n, salesTax: 0n });
    // The customer owes nothing for it.
    expect((await balances(accountId)).receivable).toBe(0n);
    await expectBooksToHold();
  });

  it("records a test-mode fee and keeps it out of the books", async () => {
    const accountId = await createAccount();
    await applyProviderFee(db, {
      accountId,
      amountMicros: 358_000n,
      feeId: "txn_test",
      mode: "test",
      post: false,
      provider: "psp",
    });
    expect(await owed()).toEqual({ fees: 0n, psp: 0n, salesTax: 0n });
    const [row] = await db.select().from(providerPayments);
    expect(row?.kind).toBe("fee");
    expect(row?.posted).toBe(false);
  });
});

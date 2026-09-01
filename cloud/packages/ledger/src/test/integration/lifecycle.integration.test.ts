import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  accountAiUsage,
  billingSettingKeys,
  checkLedgerIntegrity,
  customerCreditsCode,
  customerPromoCreditsCode,
  customerReceivableCode,
  dailySummary,
  dollarsToMicros,
  formatMicros,
  listJournalEntries,
  manualJournalEventType,
  markUsageRecordsCredited,
  postEvent,
  recentAccountAiTurns,
  recordAiUsage,
  reclassificationEventType,
  reverseEntry,
  systemAccountCodes,
  trialBalance,
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

// The golden-file tests: one customer's whole life through the books, with
// the complete journal asserted at every step rather than one balance at the
// end. Rendered as text and compared whole, so a change to any recipe shows
// up here as a diff of the books rather than as one failing number.
//
// Two walks, two models, deliberately NOT in one book. The live one is
// postpay (§3.1/§3.2): turns accrue on the receivable, a wrong charge is
// reversed and the metering subledger is told, an amount is reclassified.
// The other is the prepaid shelf (§3.5), stated by manual journal because
// its recipes are not built — it exists so a shelved model cannot quietly
// rot into something that no longer balances. The first version of this
// file mixed the two, so one customer both owed us and was owed by us, which
// is the "two models in one book" the design rejects (§9.2 item 12).

function renderJournal(entries: JournalEntry[]): string {
  return entries
    // Oldest first: a journal reads forwards.
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

function renderBalances(rows: { accountCode: string; balanceMicros: bigint }[]): string {
  return rows
    .filter((row) => row.balanceMicros !== 0n)
    .map((row) => `  ${anonymize(row.accountCode).padEnd(34)} ${formatMicros(row.balanceMicros)}`)
    .join("\n");
}

// Customer subaccount codes carry a uuid that changes every run.
function anonymize(code: string): string {
  return code.replace(/customer:[0-9a-f-]{36}/i, "customer:<id>");
}

const turnUsage = {
  cachedInputTokens: 12_000,
  inputTokens: 52_000,
  outputTokens: 30_000,
  reasoningTokens: 8_000,
};

describe("a postpay customer's life through the books", () => {
  it("accrues, reverses, reclassifies, and the customer's page agrees at every step", async () => {
    const accountId = await createAccount();
    await writeBillingSetting(db, billingSettingKeys.aiMeteringMode, "live");
    const receivable = customerReceivableCode(accountId);
    const journal = () => listJournalEntries(db, { limit: 100 });
    const month = utcMonthWindow(new Date());

    // 1. Three metered turns on the platform key, at the 30% the helper pins
    //    the PAYG row to: 442,400 × 1.3 = 575,120 each.
    for (const turnId of [
      "00000000-0000-4000-8000-00000000aa01",
      "00000000-0000-4000-8000-00000000aa02",
      "00000000-0000-4000-8000-00000000aa03",
    ]) {
      await recordAiUsage(db, {
        accountId,
        credentialSource: "platform",
        model: "gpt-5.6-terra",
        rounds: 2,
        surface: "scene_chat",
        turnId,
        usage: turnUsage,
      });
    }
    expect((await accountAiUsage(db, accountId, month)).chargeableMicros).toBe(3n * 575_120n);

    // 2. One of those turns was billed on a broken price. Never edited:
    //    reversed leg for leg, then rebooked if something correct belongs in
    //    its place — Airbnb's unbook/rebook, and the reason deltas are
    //    refused here. The metering subledger is told, so the customer's
    //    page and the daily cap stop counting the turn (§9.2 item 11).
    const charges = (await journal()).filter((entry) => entry.entryType === "ai_usage_charge");
    const wrong = charges[charges.length - 1]!;
    await reverseEntry(db, {
      accountId,
      entryId: wrong.id,
      reason: "Priced on a stale rate card",
      source: "admin",
    });
    expect(await markUsageRecordsCredited(db, wrong.id)).toBe(1);
    expect(await markUsageRecordsCredited(db, wrong.id)).toBe(0);
    expect((await accountAiUsage(db, accountId, month)).chargeableMicros).toBe(2n * 575_120n);
    expect(
      (await recentAccountAiTurns(db, accountId)).filter((turn) => turn.credited),
    ).toHaveLength(1);

    // 3. And an amount in the wrong account: reclassified, which moves it
    //    without pretending the original entry never happened.
    await postEvent(db, {
      accountId,
      eventType: reclassificationEventType,
      idempotencyKey: "reclass:1",
      payload: {
        amountMicros: "100000",
        creditAccountCode: systemAccountCodes.revenueSubscriptions,
        debitAccountCode: systemAccountCodes.revenueAiUsage,
        reason: "Part of this turn was plan-included",
      },
      source: "admin",
    });

    expect("\n" + renderJournal(await journal())).toBe(`
  ai_usage_charge
    Dr asset:receivable:customer:<id>     0.575120
    Cr revenue:ai_usage                   0.575120
  ai_usage_cost
    Dr expense:cogs:openai                0.442400
    Cr liability:accrued:openai           0.442400
  ai_usage_charge
    Dr asset:receivable:customer:<id>     0.575120
    Cr revenue:ai_usage                   0.575120
  ai_usage_cost
    Dr expense:cogs:openai                0.442400
    Cr liability:accrued:openai           0.442400
  ai_usage_charge
    Dr asset:receivable:customer:<id>     0.575120
    Cr revenue:ai_usage                   0.575120
  ai_usage_cost
    Dr expense:cogs:openai                0.442400
    Cr liability:accrued:openai           0.442400
  ai_usage_charge_reversal
    Cr asset:receivable:customer:<id>     0.575120
    Dr revenue:ai_usage                   0.575120
  reclassification
    Dr revenue:ai_usage                   0.100000
    Cr revenue:subscriptions              0.100000`);

    const balance = await trialBalance(db);
    expect(balance.balanced).toBe(true);
    expect("\n" + renderBalances(balance.rows)).toBe(`
  asset:receivable:customer:<id>     1.150240
  liability:accrued:openai           1.327200
  revenue:ai_usage                   1.050240
  revenue:subscriptions              0.100000
  expense:cogs:openai                1.327200`);

    // What the nightly job logs: revenue and provider cost over the window,
    // the margin as the gap between them, and what customers owe us — the
    // receivable, which is the number the month-end invoice collects.
    const summary = await dailySummary(db, {
      since: new Date(Date.now() - 60 * 60 * 1000),
      until: new Date(Date.now() + 60 * 60 * 1000),
    });
    expect(formatMicros(summary.revenueMicros)).toBe("1.150240");
    expect(formatMicros(summary.cogsMicros)).toBe("1.327200");
    expect(formatMicros(summary.contraRevenueMicros)).toBe("0.000000");
    expect(formatMicros(summary.marginMicros)).toBe("-0.176960");
    expect(formatMicros(summary.customerLiabilityMicros)).toBe("0.000000");
    expect(formatMicros(summary.customerReceivableMicros)).toBe("1.150240");
    expect(await accountBalanceMicros(receivable)).toBe(1_150_240n);

    expect(await checkLedgerIntegrity(db, { pendingEventGraceMs: 0 })).toEqual([]);
  });
});

async function accountBalanceMicros(code: string): Promise<bigint> {
  const rows = await trialBalance(db);
  return rows.rows.find((row) => row.accountCode === code)?.balanceMicros ?? 0n;
}

describe("the prepaid shelf (§3.5), kept balanced without being built", () => {
  it("stays balanced through purchase, fee, grant, spend and reversal", async () => {
    const accountId = await createAccount();
    const credits = customerCreditsCode(accountId);
    const journal = () => listJournalEntries(db, { limit: 100 });
    const manual = (key: string, description: string, legs: unknown[], extra: Record<string, unknown> = {}) =>
      postEvent(db, {
        accountId,
        eventType: manualJournalEventType,
        idempotencyKey: key,
        payload: { description, legs, ...extra },
        source: "admin",
      });

    // 1. They buy $10 of credit; the provider's fee is our cost, not theirs.
    await manual("purchase:1", "Prepaid credit purchase", [
      { accountCode: systemAccountCodes.psp, amountMicros: dollarsToMicros(10).toString(), direction: "debit" },
      { accountCode: credits, amountMicros: dollarsToMicros(10).toString(), direction: "credit" },
    ], { externalRef: "psp_ref_123" });
    await manual("psp_fee:1", "Payment provider fee", [
      { accountCode: systemAccountCodes.pspFees, amountMicros: "590000", direction: "debit" },
      { accountCode: systemAccountCodes.psp, amountMicros: "590000", direction: "credit" },
    ]);
    // 2. A welcome grant, in its own liability: not deferred revenue, never
    //    refunded.
    await manual("promo:1", "Welcome credit", [
      { accountCode: systemAccountCodes.promoContraRevenue, amountMicros: dollarsToMicros(5).toString(), direction: "debit" },
      { accountCode: customerPromoCreditsCode(accountId), amountMicros: dollarsToMicros(5).toString(), direction: "credit" },
    ]);
    // 3. A turn drawn down from the prepaid balance — rule v1's shape, stated
    //    by hand because v1 is what the shelf holds.
    await manual("spend:1", "AI usage against prepaid credit", [
      { accountCode: credits, amountMicros: "575120", direction: "debit" },
      { accountCode: systemAccountCodes.revenueAiUsage, amountMicros: "575120", direction: "credit" },
    ]);
    // 4. And that turn reversed.
    const spend = (await journal()).find((entry) => entry.description.startsWith("AI usage"))!;
    await reverseEntry(db, { accountId, entryId: spend.id, reason: "Test reversal", source: "admin" });

    expect("\n" + renderJournal(await journal())).toBe(`
  manual_journal
    Dr asset:psp:main                     10.000000
    Cr liability:credits:customer:<id>    10.000000
  manual_journal
    Dr expense:psp_fees                   0.590000
    Cr asset:psp:main                     0.590000
  manual_journal
    Dr contra_revenue:promo               5.000000
    Cr liability:credits_promo:customer:<id> 5.000000
  manual_journal
    Dr liability:credits:customer:<id>    0.575120
    Cr revenue:ai_usage                   0.575120
  manual_journal_reversal
    Cr liability:credits:customer:<id>    0.575120
    Dr revenue:ai_usage                   0.575120`);

    const balance = await trialBalance(db);
    expect(balance.balanced).toBe(true);
    expect("\n" + renderBalances(balance.rows)).toBe(`
  asset:psp:main                     9.410000
  liability:credits:customer:<id>    10.000000
  liability:credits_promo:customer:<id> 5.000000
  contra_revenue:promo               5.000000
  expense:psp_fees                   0.590000`);

    const summary = await dailySummary(db, {
      since: new Date(Date.now() - 60 * 60 * 1000),
      until: new Date(Date.now() + 60 * 60 * 1000),
    });
    // Fees are not provider cost: they sit beside the margin, not inside it.
    expect(formatMicros(summary.cogsMicros)).toBe("0.000000");
    expect(formatMicros(summary.pspFeesMicros)).toBe("0.590000");
    expect(formatMicros(summary.contraRevenueMicros)).toBe("5.000000");
    expect(formatMicros(summary.customerLiabilityMicros)).toBe("15.000000");
    expect(formatMicros(summary.customerReceivableMicros)).toBe("0.000000");

    expect(await checkLedgerIntegrity(db, { pendingEventGraceMs: 0 })).toEqual([]);
  });
});

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  billingSettingKeys,
  checkLedgerIntegrity,
  customerCreditsCode,
  customerPromoCreditsCode,
  dailySummary,
  dollarsToMicros,
  formatMicros,
  listJournalEntries,
  manualJournalEventType,
  postEvent,
  recordAiUsage,
  reclassificationEventType,
  reverseEntry,
  systemAccountCodes,
  trialBalance,
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

// The golden-file test: one customer's whole life through the books, with
// the complete journal asserted at every step rather than one balance at the
// end.
//
// This one deliberately mixes both models. The metered turns post the LIVE
// postpay shape (rule v2: the charge debits the customer's receivable), while
// the purchase and the promo grant exercise the prepaid accounts §3.5 keeps
// on the shelf — which is what stops a shelved model from quietly rotting
// into something that no longer balances. subscriptions.integration.test.ts
// is the postpay + subscription walk. The unit tests prove each recipe in isolation; this proves the
// sequence, which is where accounting bugs actually live — a charge that
// posts fine on its own and leaves the wrong liability behind once a refund
// and a reversal have happened around it.
//
// Rendered as text and compared whole, so a change to any recipe shows up
// here as a diff of the books rather than as one failing number.

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

describe("a customer's life through the books", () => {
  it("stays balanced and explainable through purchase, usage, refund and reversal", async () => {
    const accountId = await createAccount();
    await writeBillingSetting(db, billingSettingKeys.aiMeteringMode, "live");
    const credits = customerCreditsCode(accountId);
    const journal = () => listJournalEntries(db, { limit: 100 });

    // 1. They buy $10 of credit. Until Phase 3 has a payment provider this
    //    is stated by hand, which is exactly what the manual journal is for
    //    — and the entry it posts is the one the purchase recipe will.
    await postEvent(db, {
      accountId,
      eventType: manualJournalEventType,
      idempotencyKey: "purchase:1",
      payload: {
        description: "Prepaid credit purchase",
        externalRef: "psp_ref_123",
        legs: [
          {
            accountCode: systemAccountCodes.psp,
            amountMicros: dollarsToMicros(10).toString(),
            direction: "debit",
          },
          { accountCode: credits, amountMicros: dollarsToMicros(10).toString(), direction: "credit" },
        ],
      },
      source: "admin",
    });

    // 2. The provider's fee on that purchase is our cost, not theirs: their
    //    balance is the full ten dollars.
    await postEvent(db, {
      eventType: manualJournalEventType,
      idempotencyKey: "psp_fee:1",
      payload: {
        description: "Payment provider fee",
        legs: [
          { accountCode: systemAccountCodes.pspFees, amountMicros: "590000", direction: "debit" },
          { accountCode: systemAccountCodes.psp, amountMicros: "590000", direction: "credit" },
        ],
      },
      source: "admin",
    });

    // 3. A welcome grant. Promo credits live in their own liability account
    //    because they are not deferred revenue and never get refunded.
    await postEvent(db, {
      accountId,
      eventType: manualJournalEventType,
      idempotencyKey: "promo:1",
      payload: {
        description: "Welcome credit",
        legs: [
          {
            accountCode: systemAccountCodes.promoContraRevenue,
            amountMicros: dollarsToMicros(5).toString(),
            direction: "debit",
          },
          {
            accountCode: customerPromoCreditsCode(accountId),
            amountMicros: dollarsToMicros(5).toString(),
            direction: "credit",
          },
        ],
      },
      source: "admin",
    });

    // 4. Two metered turns on the platform key.
    for (const turnId of ["00000000-0000-4000-8000-00000000aa01", "00000000-0000-4000-8000-00000000aa02"]) {
      await recordAiUsage(db, {
        accountId,
        credentialSource: "platform",
        model: "gpt-5.6-terra",
        rounds: 2,
        surface: "scene_chat",
        turnId,
        usage: {
          cachedInputTokens: 12_000,
          inputTokens: 52_000,
          outputTokens: 30_000,
          reasoningTokens: 8_000,
        },
      });
    }

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
    Cr liability:accrued:openai           0.442400`);

    // 5. One of those turns was billed on a broken price. Never edited:
    //    reversed leg for leg, then rebooked — Airbnb's unbook/rebook, and
    //    the reason deltas are refused here.
    const charges = (await journal()).filter((entry) => entry.entryType === "ai_usage_charge");
    await reverseEntry(db, {
      accountId,
      entryId: charges[0]!.id,
      reason: "Priced on a stale rate card",
      source: "admin",
    });

    // 6. And an amount in the wrong account: reclassified, which moves it
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

    const balance = await trialBalance(db);
    expect(balance.balanced).toBe(true);
    expect("\n" + renderBalances(balance.rows)).toBe(`
  asset:psp:main                     9.410000
  asset:receivable:customer:<id>     0.575120
  liability:accrued:openai           0.884800
  liability:credits:customer:<id>    10.000000
  liability:credits_promo:customer:<id> 5.000000
  contra_revenue:promo               5.000000
  revenue:ai_usage                   0.475120
  revenue:subscriptions              0.100000
  expense:cogs:openai                0.884800
  expense:psp_fees                   0.590000`);

    // What the nightly job logs: revenue and cost over the window, the
    // margin as the gap between them, and what we still owe customers.
    const summary = await dailySummary(db, {
      since: new Date(Date.now() - 60 * 60 * 1000),
      until: new Date(Date.now() + 60 * 60 * 1000),
    });
    expect(formatMicros(summary.revenueMicros)).toBe("0.575120");
    expect(formatMicros(summary.cogsMicros)).toBe("1.474800");
    // The $5 welcome grant is contra-revenue, so the month it was given in
    // reads as a loss: it is recognized now, and the revenue it will offset
    // arrives whenever the customer gets round to spending it.
    expect(formatMicros(summary.contraRevenueMicros)).toBe("5.000000");
    expect(formatMicros(summary.netRevenueMicros)).toBe("-4.424880");
    expect(formatMicros(summary.marginMicros)).toBe("-5.899680");
    // Two different customer balances now, and the distinction is the whole
    // of §0: the prepaid liability is what we owe them (still the full $15
    // they were given, because postpay never draws it down), and the
    // receivable is what they owe us for the one charge that survived the
    // reversal.
    expect(formatMicros(summary.customerLiabilityMicros)).toBe("15.000000");
    expect(formatMicros(summary.customerReceivableMicros)).toBe("0.575120");

    // Every invariant, after all of it.
    expect(
      await checkLedgerIntegrity(db, { pendingEventGraceMs: 0 }),
    ).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { aiUsageRule } from "./ai-usage";
import { manualJournalRule } from "./manual-journal";
import { reclassificationRule } from "./reclassification";
import { reversalRule } from "./reversal";
import {
  LedgerError,
  type FinancialEventRecord,
  type PostedEntry,
  type RuleContext,
} from "../types";

const occurredAt = new Date("2026-09-01T10:00:00.000Z");

function event(payload: Record<string, unknown>): FinancialEventRecord {
  return {
    accountId: null,
    eventType: "test",
    id: "11111111-1111-1111-1111-111111111111",
    idempotencyKey: "test",
    occurredAt,
    payload,
    processedAt: null,
    source: "admin",
    sourceRef: null,
  };
}

const original: PostedEntry = {
  description: "AI usage on turn 7",
  entryType: "ai_usage_charge",
  externalRef: null,
  id: "22222222-2222-2222-2222-222222222222",
  metadata: {},
  occurredAt: new Date("2026-08-01T10:00:00.000Z"),
  postings: [
    {
      accountCode: "liability:credits:customer:5f1c1b3e-2c9a-4a1e-9d3b-6f4f1a2b3c4d",
      amountMicros: 575_120n,
      currency: "USD",
      direction: "debit",
    },
    {
      accountCode: "revenue:ai_usage",
      amountMicros: 575_120n,
      currency: "USD",
      direction: "credit",
    },
  ],
  reversesEntryId: null,
  ruleVersion: 1,
};

function context(overrides: Partial<RuleContext> = {}): RuleContext {
  return {
    findReversal: async () => undefined,
    loadEntry: async () => original,
    ...overrides,
  };
}

describe("manual journal rule", () => {
  it("turns stated legs into one entry", async () => {
    const [entry] = await manualJournalRule.build(
      event({
        description: "Opening balance",
        legs: [
          {
            accountCode: "asset:bank:main",
            amountMicros: "10000000",
            direction: "debit",
          },
          {
            accountCode: "liability:accrued:openai",
            amountMicros: 10_000_000,
            direction: "credit",
          },
        ],
      }),
      context(),
    );

    expect(entry?.entryType).toBe("manual_journal");
    expect(entry?.occurredAt).toBe(occurredAt);
    expect(entry?.postings).toEqual([
      {
        accountCode: "asset:bank:main",
        amountMicros: 10_000_000n,
        direction: "debit",
      },
      {
        accountCode: "liability:accrued:openai",
        amountMicros: 10_000_000n,
        direction: "credit",
      },
    ]);
  });

  it("insists on a description and at least two legs", () => {
    expect(() =>
      manualJournalRule.build(event({ legs: [] }), context()),
    ).toThrow(LedgerError);
    expect(() =>
      manualJournalRule.build(
        event({
          description: "One-legged",
          legs: [
            {
              accountCode: "asset:bank:main",
              amountMicros: "1",
              direction: "debit",
            },
          ],
        }),
        context(),
      ),
    ).toThrow(/at least two legs/);
  });
});

describe("reversal rule", () => {
  it("mirrors every leg of the entry it reverses", async () => {
    const [entry] = await reversalRule.build(
      event({ entryId: original.id, reason: "Charged the wrong account" }),
      context(),
    );

    expect(entry?.entryType).toBe("ai_usage_charge_reversal");
    expect(entry?.reversesEntryId).toBe(original.id);
    expect(entry?.postings).toEqual([
      { ...original.postings[0], direction: "credit" },
      { ...original.postings[1], direction: "debit" },
    ]);
    // The reversal belongs to today; the entry it undoes keeps its period.
    expect(entry?.occurredAt).toBe(occurredAt);
    expect(entry?.metadata).toMatchObject({
      reason: "Charged the wrong account",
      reversedOccurredAt: original.occurredAt.toISOString(),
    });
  });

  it("needs a reason, a real entry, and one that is not already reversed", async () => {
    await expect(
      reversalRule.build(event({ entryId: original.id }), context()),
    ).rejects.toThrow(/reason/);
    await expect(
      reversalRule.build(
        event({ entryId: original.id, reason: "gone" }),
        context({ loadEntry: async () => undefined }),
      ),
    ).rejects.toThrow(/does not exist/);
    await expect(
      reversalRule.build(
        event({ entryId: original.id, reason: "again" }),
        context({ findReversal: async () => ({ ...original, id: "33333333-3333-3333-3333-333333333333" }) }),
      ),
    ).rejects.toThrow(/already reversed/);
  });
});

const customerId = "5f1c1b3e-2c9a-4a1e-9d3b-6f4f1a2b3c4d";

// The worked example from the design doc: a terra turn costing us 442,400
// micro-dollars, priced at 575,120 with a 30% margin.
function meteredTurn(overrides: Record<string, unknown> = {}) {
  return {
    ...event({
      costMicros: "442400",
      credentialSource: "platform",
      model: "gpt-5.6-terra",
      priceMicros: "575120",
      pricing: { marginBasisPoints: 3000 },
      rounds: 3,
      tokens: { cachedInput: 12000, input: 40000, output: 30000, reasoning: 8000 },
      usageRecordId: "44444444-4444-4444-4444-444444444444",
      ...overrides,
    }),
    accountId: customerId,
  };
}

describe("ai usage rule", () => {
  // Two entries, not one: what the customer owes us and what we owe the
  // provider are different amounts against different counterparties, and the
  // margin is the gap between them rather than anything posted.
  it("posts the customer charge and the provider cost as independent entries", async () => {
    const entries = await aiUsageRule.build(meteredTurn(), context());

    expect(entries.map((entry) => entry.entryType)).toEqual([
      "ai_usage_charge",
      "ai_usage_cost",
    ]);
    expect(entries[0]?.postings).toEqual([
      {
        accountCode: `liability:credits:customer:${customerId}`,
        amountMicros: 575_120n,
        direction: "debit",
      },
      { accountCode: "revenue:ai_usage", amountMicros: 575_120n, direction: "credit" },
    ]);
    expect(entries[1]?.postings).toEqual([
      { accountCode: "expense:cogs:openai", amountMicros: 442_400n, direction: "debit" },
      { accountCode: "liability:accrued:openai", amountMicros: 442_400n, direction: "credit" },
    ]);
    // Both carry the pricing snapshot: an entry has to stay explainable
    // after the price table and the margin have moved on.
    for (const entry of entries) {
      expect(entry.metadata).toMatchObject({
        costMicros: "442400",
        model: "gpt-5.6-terra",
        pricing: { marginBasisPoints: 3000 },
        priceMicros: "575120",
      });
    }
  });

  // The operator's shared key: a real cost we absorb, billed to nobody.
  it("posts cost alone when the turn was on the operator key", async () => {
    const entries = await aiUsageRule.build(
      meteredTurn({ credentialSource: "shared", priceMicros: "0" }),
      context(),
    );
    expect(entries.map((entry) => entry.entryType)).toEqual(["ai_usage_cost"]);
  });

  it("refuses a turn that moved no money, and a priced turn with nobody to bill", () => {
    expect(() =>
      aiUsageRule.build(meteredTurn({ costMicros: "0", priceMicros: "0" }), context()),
    ).toThrow(/no entries to post/);
    expect(() =>
      aiUsageRule.build({ ...meteredTurn(), accountId: null }, context()),
    ).toThrow(/must name the account/);
  });
});

describe("reclassification rule", () => {
  it("moves an amount between two accounts without touching the original", async () => {
    const [entry] = await reclassificationRule.build(
      event({
        amountMicros: "575120",
        creditAccountCode: "revenue:subscriptions",
        debitAccountCode: "revenue:ai_usage",
        reason: "Booked as usage, was a plan fee",
        reclassifiesEntryId: original.id,
      }),
      context(),
    );

    expect(entry?.entryType).toBe("reclassification");
    // Never reverses_entry_id: that column promises the two entries cancel
    // leg for leg, and the integrity checker proves it for every row that
    // has it. A reclass moves one amount and leaves the rest alone.
    expect(entry?.reversesEntryId).toBeUndefined();
    expect(entry?.metadata).toEqual({
      reason: "Booked as usage, was a plan fee",
      reclassifies: original.id,
    });
    expect(entry?.postings).toEqual([
      { accountCode: "revenue:ai_usage", amountMicros: 575_120n, direction: "debit" },
      { accountCode: "revenue:subscriptions", amountMicros: 575_120n, direction: "credit" },
    ]);
  });

  it("insists on two different accounts, a positive amount and a reason", async () => {
    const base = {
      amountMicros: "1000",
      creditAccountCode: "revenue:subscriptions",
      debitAccountCode: "revenue:ai_usage",
      reason: "why",
    };
    await expect(
      reclassificationRule.build(event({ ...base, reason: "  " }), context()),
    ).rejects.toThrow(/reason/);
    await expect(
      reclassificationRule.build(
        event({ ...base, creditAccountCode: "revenue:ai_usage" }),
        context(),
      ),
    ).rejects.toThrow(/itself/);
    await expect(
      reclassificationRule.build(event({ ...base, amountMicros: "0" }), context()),
    ).rejects.toThrow(/positive/);
    await expect(
      reclassificationRule.build(
        event({ ...base, reclassifiesEntryId: original.id }),
        context({ loadEntry: async () => undefined }),
      ),
    ).rejects.toThrow(/does not exist/);
  });
});

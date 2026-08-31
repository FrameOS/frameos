import { describe, expect, it } from "vitest";
import { manualJournalRule } from "./manual-journal";
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

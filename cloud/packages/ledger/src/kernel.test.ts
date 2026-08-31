import { describe, expect, it } from "vitest";
import { validateDrafts } from "./kernel";
import { LedgerError, type EntryDraft, type PostingRule } from "./types";

const rule: PostingRule = {
  build: () => [],
  name: "test_rule",
  version: 1,
};

function draft(overrides: Partial<EntryDraft> = {}): EntryDraft {
  return {
    description: "Test",
    entryType: "test_entry",
    postings: [
      {
        accountCode: "asset:bank:main",
        amountMicros: 1_000n,
        direction: "debit",
      },
      {
        accountCode: "revenue:ai_usage",
        amountMicros: 1_000n,
        direction: "credit",
      },
    ],
    ...overrides,
  };
}

describe("draft validation", () => {
  it("accepts a balanced entry", () => {
    expect(() => validateDrafts([draft()], rule)).not.toThrow();
  });

  it("refuses an entry that does not balance", () => {
    expect(() =>
      validateDrafts(
        [
          draft({
            postings: [
              {
                accountCode: "asset:bank:main",
                amountMicros: 1_000n,
                direction: "debit",
              },
              {
                accountCode: "revenue:ai_usage",
                amountMicros: 999n,
                direction: "credit",
              },
            ],
          }),
        ],
        rule,
      ),
    ).toThrow(LedgerError);
  });

  // Balanced in total, but each currency has to stand on its own: ten
  // dollars debited and ten euros credited is not an entry.
  it("balances each currency separately", () => {
    expect(() =>
      validateDrafts(
        [
          draft({
            postings: [
              {
                accountCode: "asset:bank:main",
                amountMicros: 1_000n,
                currency: "USD",
                direction: "debit",
              },
              {
                accountCode: "revenue:ai_usage",
                amountMicros: 1_000n,
                currency: "EUR",
                direction: "credit",
              },
            ],
          }),
        ],
        rule,
      ),
    ).toThrow(/out of balance/);
  });

  it("refuses negative amounts, lone legs and empty output", () => {
    expect(() =>
      validateDrafts(
        [
          draft({
            postings: [
              {
                accountCode: "asset:bank:main",
                amountMicros: -1_000n,
                direction: "debit",
              },
              {
                accountCode: "revenue:ai_usage",
                amountMicros: -1_000n,
                direction: "credit",
              },
            ],
          }),
        ],
        rule,
      ),
    ).toThrow(/positive/);
    expect(() =>
      validateDrafts([draft({ postings: [draft().postings[0]!] })], rule),
    ).toThrow(/at least two postings/);
    expect(() => validateDrafts([], rule)).toThrow(/no entries/);
  });

  // Two entries of one type from a single event is the shape a double-post
  // takes, so it is refused unless the rule declares the multiplicity.
  it("refuses a repeated entry type unless the rule allows it", () => {
    expect(() => validateDrafts([draft(), draft()], rule)).toThrow(/twice/);
    expect(() =>
      validateDrafts([draft(), draft()], {
        ...rule,
        allowsRepeatedEntryTypes: true,
      }),
    ).not.toThrow();
  });
});

import { describe, expect, it } from "vitest";
import {
  applyMarginMicros,
  divideRoundHalfUp,
  fallbackModelPrice,
  priceUsage,
  providerCostMicros,
  splitProviderUsage,
  type ModelPrice,
} from "./pricing";
import { LedgerError } from "./types";

// gpt-5.6-terra: $2 / $0.20 / $12 per 1M input / cached / output.
const terra: ModelPrice = {
  cachedInputMicrosPerMtok: 200_000n,
  currency: "USD",
  effectiveFrom: new Date("1970-01-01T00:00:00.000Z"),
  inputMicrosPerMtok: 2_000_000n,
  model: "gpt-5.6-terra",
  outputMicrosPerMtok: 12_000_000n,
  source: "table",
};

describe("provider usage", () => {
  // OpenAI reports input_tokens INCLUDING the cached ones. Metering them as
  // separate line items would bill the cached half twice, once at each price.
  it("separates cached input from the total the provider reports", () => {
    expect(
      splitProviderUsage({
        cachedInputTokens: 12_000,
        inputTokens: 52_000,
        outputTokens: 30_000,
        reasoningTokens: 8_000,
      }),
    ).toEqual({
      cachedInputTokens: 12_000,
      inputTokens: 40_000,
      outputTokens: 30_000,
      reasoningTokens: 8_000,
    });
  });

  it("clamps nonsense rather than metering a negative", () => {
    expect(
      splitProviderUsage({ cachedInputTokens: 900, inputTokens: 100 }),
    ).toEqual({
      cachedInputTokens: 900,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
    });
    expect(splitProviderUsage({})).toEqual({
      cachedInputTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
    });
  });
});

describe("pricing a turn", () => {
  // The worked example from the design doc, §3.2: 40k uncached input, 12k
  // cached, 30k output on terra costs 40000x2 + 12000x0.2 + 30000x12
  // micro-dollars = 442,400, and at a 30% margin prices at 575,120.
  it("computes the documented cost and price exactly", () => {
    const usage = splitProviderUsage({
      cachedInputTokens: 12_000,
      inputTokens: 52_000,
      outputTokens: 30_000,
      reasoningTokens: 0,
    });
    expect(providerCostMicros(usage, terra)).toBe(442_400n);

    const priced = priceUsage({
      billable: true,
      marginBasisPoints: 3_000,
      price: terra,
      usage,
    });
    expect(priced.costMicros).toBe(442_400n);
    expect(priced.priceMicros).toBe(575_120n);
    expect(priced.snapshot).toMatchObject({
      inputMicrosPerMtok: "2000000",
      marginBasisPoints: 3_000,
      model: "gpt-5.6-terra",
      priceSource: "table",
    });
  });

  // A turn on the customer's own key: we still measure what it burned, but
  // there is nothing to charge them for — they paid the provider directly.
  it("prices a non-billable turn at zero and still costs it out", () => {
    const priced = priceUsage({
      billable: false,
      marginBasisPoints: 3_000,
      price: terra,
      usage: splitProviderUsage({ inputTokens: 1_000, outputTokens: 1_000 }),
    });
    expect(priced.costMicros).toBe(14_000n);
    expect(priced.priceMicros).toBe(0n);
  });

  // One rounding step per record, not per token: a single output token on a
  // model priced at $12/1M is 12 micro-dollars, and a single cached token on
  // gpt-4o-mini is a fifteenth of one — which per-token integer prices could
  // not represent at all, and which the per-million unit rounds exactly once.
  it("rounds once, at the record, half away from zero", () => {
    expect(divideRoundHalfUp(1_500_000n, 1_000_000n)).toBe(2n);
    expect(divideRoundHalfUp(1_499_999n, 1_000_000n)).toBe(1n);
    expect(divideRoundHalfUp(-1_500_000n, 1_000_000n)).toBe(-2n);
    expect(() => divideRoundHalfUp(1n, 0n)).toThrow(LedgerError);

    const mini = fallbackModelPrice("gpt-4o-mini");
    expect(mini.cachedInputMicrosPerMtok).toBe(75_000n);
    // 3 cached tokens at $0.075/1M = 0.225 micro-dollars, which rounds to 0
    // — and 7 of them to 1. Neither is expressible at all if the price
    // itself has to be a whole number of micro-dollars per token.
    expect(
      providerCostMicros(splitProviderUsage({ cachedInputTokens: 3, inputTokens: 3 }), mini),
    ).toBe(0n);
    expect(
      providerCostMicros(splitProviderUsage({ cachedInputTokens: 7, inputTokens: 7 }), mini),
    ).toBe(1n);
  });

  it("applies a fractional margin without a float reaching the money", () => {
    // 12.5% of 442,400 is 55,300 exactly.
    expect(applyMarginMicros(442_400n, 1_250)).toBe(497_700n);
    expect(applyMarginMicros(0n, 3_000)).toBe(0n);
    expect(() => applyMarginMicros(1n, -1)).toThrow(LedgerError);
    expect(() => applyMarginMicros(1n, 30.5)).toThrow(LedgerError);
  });

  // A model nobody has priced must not meter free: an unknown price that
  // reads as zero would hide the whole of its spend.
  it("falls back to a deliberately conservative price for an unknown model", () => {
    const unknown = fallbackModelPrice("gpt-9.9-unreleased");
    expect(unknown.source).toBe("fallback");
    expect(unknown.inputMicrosPerMtok).toBeGreaterThan(0n);
    expect(unknown.outputMicrosPerMtok).toBeGreaterThan(0n);
  });
});

import { and, desc, eq, lte } from "drizzle-orm";
import { aiModelPrices } from "@frameos-cloud/db";
import { LedgerError, type LedgerExecutor } from "./types";

// What a turn cost us, and what it costs the customer.
//
// Two rules hold this together, and both are easy to get wrong:
//
//  1. **One rounding step per usage record, never per token.** Prices are
//     micro-dollars per MILLION tokens, so the whole computation stays in
//     bigints and the single division at the end is the only place a
//     fraction is lost. Per-token prices were the first design and they
//     cannot even represent the cheap models: a cached gpt-4o-mini token is
//     0.075 micro-dollars, which as an integer is zero.
//
//  2. **Token counts here are disjoint.** The provider reports
//     `input_tokens` INCLUDING the cached ones; we split them, because
//     multiplying a total that secretly contains a differently-priced part
//     is the bug that shows up as a percent of revenue and never as a
//     crash. `splitProviderUsage` is the one door provider numbers come
//     through.

// Micro-dollars per million tokens: the unit every price in this module and
// in ai_model_prices is expressed in.
const microsPerMtok = 1_000_000n;

export interface ModelPrice {
  cachedInputMicrosPerMtok: bigint;
  currency: string;
  effectiveFrom: Date | null;
  inputMicrosPerMtok: bigint;
  model: string;
  outputMicrosPerMtok: bigint;
  // Where the numbers came from: a row in ai_model_prices, or the fallback
  // table below. Snapshotted into the entry so "why did this cost that?" is
  // answerable a year later.
  source: "table" | "fallback";
}

// Disjoint token counts: `inputTokens` excludes `cachedInputTokens`, and
// `reasoningTokens` is a subset of `outputTokens` kept for analysis only.
export interface TokenUsage {
  cachedInputTokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

// USD per 1M tokens as of 2026-08-31, the same numbers migration 0043 seeds
// and apps/auth-web/evals/compare-models.ts estimates with. This is the
// answer for a model nobody has priced yet — a missing price must not
// silently meter a turn at zero, and refusing to meter it would lose the
// measurement entirely.
export const fallbackModelPrices: Record<
  string,
  { cached: number; input: number; output: number }
> = {
  "gpt-4o-mini": { cached: 0.075, input: 0.15, output: 0.6 },
  "gpt-5.5": { cached: 0.5, input: 5, output: 30 },
  "gpt-5.6-luna": { cached: 0.02, input: 0.2, output: 1.2 },
  "gpt-5.6-sol": { cached: 0.4, input: 4, output: 20 },
  "gpt-5.6-terra": { cached: 0.2, input: 2, output: 12 },
};

// A model we have never seen at all. Zero would meter it free and hide the
// spend; the priciest thing we know of overstates it, which is the direction
// an unknown cost should err in, and the snapshot says `estimated` so the
// admin books can show which rows are guesses.
export const unknownModelPrice = { cached: 0.5, input: 5, output: 30 };

// Dollars per 1M tokens -> micro-dollars per 1M tokens, exactly. Prices are
// quoted to at most six decimal places of a dollar per million, which is
// what makes this a safe integer conversion rather than a rounding.
function dollarsPerMtokToMicros(dollars: number): bigint {
  const micros = Math.round(dollars * 1_000_000);
  if (!Number.isSafeInteger(micros)) {
    throw new LedgerError(
      "invalid_amount",
      `${dollars} dollars per million tokens is not an exact micro-dollar price`,
    );
  }
  return BigInt(micros);
}

export function fallbackModelPrice(model: string): ModelPrice {
  const known = fallbackModelPrices[model];
  const price = known ?? unknownModelPrice;
  return {
    cachedInputMicrosPerMtok: dollarsPerMtokToMicros(price.cached),
    currency: "USD",
    effectiveFrom: null,
    inputMicrosPerMtok: dollarsPerMtokToMicros(price.input),
    model,
    outputMicrosPerMtok: dollarsPerMtokToMicros(price.output),
    source: "fallback",
  };
}

// The price in force for a model at a moment. Effective-dated: a price
// change is a new row, and a turn metered late still prices at what was
// current when it ran.
export async function resolveModelPrice(
  db: LedgerExecutor,
  model: string,
  at: Date = new Date(),
): Promise<ModelPrice> {
  const [row] = await db
    .select()
    .from(aiModelPrices)
    .where(
      and(eq(aiModelPrices.model, model), lte(aiModelPrices.effectiveFrom, at)),
    )
    .orderBy(desc(aiModelPrices.effectiveFrom))
    .limit(1);
  if (!row) {
    return fallbackModelPrice(model);
  }
  return {
    cachedInputMicrosPerMtok: row.cachedInputMicrosPerMtok,
    currency: row.currency,
    effectiveFrom: row.effectiveFrom,
    inputMicrosPerMtok: row.inputMicrosPerMtok,
    model: row.model,
    outputMicrosPerMtok: row.outputMicrosPerMtok,
    source: "table",
  };
}

// Provider usage -> our disjoint counts. OpenAI's `input_tokens` includes
// the cached ones and its `output_tokens` includes reasoning; the first is a
// price difference and so has to be separated, the second is not and so is
// left alone.
export function splitProviderUsage(usage: {
  cachedInputTokens?: number | undefined;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  reasoningTokens?: number | undefined;
}): TokenUsage {
  const count = (value: number | undefined) =>
    typeof value === "number" && Number.isFinite(value) && value > 0
      ? Math.round(value)
      : 0;
  const cachedInputTokens = count(usage.cachedInputTokens);
  const reportedInput = count(usage.inputTokens);
  return {
    cachedInputTokens,
    // A provider that reports fewer input tokens than cached ones is
    // reporting nonsense; clamp rather than bill a negative.
    inputTokens: Math.max(0, reportedInput - cachedInputTokens),
    outputTokens: count(usage.outputTokens),
    reasoningTokens: count(usage.reasoningTokens),
  };
}

// Integer division, half away from zero. The one rounding step in the whole
// pricing path.
export function divideRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) {
    throw new LedgerError("invalid_amount", "Cannot divide by a non-positive denominator");
  }
  const negative = numerator < 0n;
  const absolute = negative ? -numerator : numerator;
  const rounded = (absolute * 2n + denominator) / (denominator * 2n);
  return negative ? -rounded : rounded;
}

// What the provider charges for this turn, in micro-dollars.
export function providerCostMicros(usage: TokenUsage, price: ModelPrice): bigint {
  const weighted =
    BigInt(usage.inputTokens) * price.inputMicrosPerMtok +
    BigInt(usage.cachedInputTokens) * price.cachedInputMicrosPerMtok +
    BigInt(usage.outputTokens) * price.outputMicrosPerMtok;
  return divideRoundHalfUp(weighted, microsPerMtok);
}

// Cost plus margin. Basis points rather than percent so "30.5%" is
// expressible without a float creeping into a money computation.
export function applyMarginMicros(
  costMicros: bigint,
  marginBasisPoints: number,
): bigint {
  if (!Number.isInteger(marginBasisPoints) || marginBasisPoints < 0) {
    throw new LedgerError(
      "invalid_amount",
      `Margin must be a non-negative whole number of basis points, got ${marginBasisPoints}`,
    );
  }
  return divideRoundHalfUp(
    costMicros * BigInt(10_000 + marginBasisPoints),
    10_000n,
  );
}

export interface PricedUsage {
  costMicros: bigint;
  currency: string;
  price: ModelPrice;
  priceMicros: bigint;
  // Exactly what went into the two numbers, ready to be written into
  // ai_usage_records.pricing and the ledger entry's metadata.
  snapshot: Record<string, unknown>;
  usage: TokenUsage;
}

// The whole computation for one turn: cost when the key was ours, price when
// the customer is the one paying for it.
export function priceUsage(input: {
  // Do we pay the provider for this turn? False for a turn on the
  // customer's own key.
  billable: boolean;
  marginBasisPoints: number;
  price: ModelPrice;
  usage: TokenUsage;
}): PricedUsage {
  const costMicros = providerCostMicros(input.usage, input.price);
  const priceMicros = input.billable
    ? applyMarginMicros(costMicros, input.marginBasisPoints)
    : 0n;
  return {
    costMicros,
    currency: input.price.currency,
    price: input.price,
    priceMicros,
    snapshot: {
      cachedInputMicrosPerMtok: input.price.cachedInputMicrosPerMtok.toString(),
      currency: input.price.currency,
      effectiveFrom: input.price.effectiveFrom?.toISOString() ?? null,
      inputMicrosPerMtok: input.price.inputMicrosPerMtok.toString(),
      marginBasisPoints: input.marginBasisPoints,
      model: input.price.model,
      outputMicrosPerMtok: input.price.outputMicrosPerMtok.toString(),
      priceSource: input.price.source,
    },
    usage: input.usage,
  };
}

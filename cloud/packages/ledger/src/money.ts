import { LedgerError } from "./types";

// One US dollar in micro-dollars. Every amount in the ledger is an integer
// count of these: at gpt-5.6-terra prices a single token costs 2 / 0.2 / 12
// of them, so micro precision is what lets per-token arithmetic stay exact
// with one rounding step per usage record rather than one per token.
export const microsPerDollar = 1_000_000n;

// Amounts cross into the ledger through jsonb payloads, where a bigint
// cannot survive: JSON has one number type and it loses integers above 2^53.
// So payloads carry amounts as decimal strings (or as numbers, when they are
// small and exact), and this is the only door they come through.
export function parseMicros(value: unknown, label: string): bigint {
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new LedgerError(
        "invalid_amount",
        `${label} must be a whole number of micro-dollars, got ${value}`,
      );
    }
    return BigInt(value);
  }
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    return BigInt(value.trim());
  }
  throw new LedgerError(
    "invalid_amount",
    `${label} must be an integer number of micro-dollars, got ${JSON.stringify(value)}`,
  );
}

export function dollarsToMicros(dollars: number): bigint {
  const micros = Math.round(dollars * Number(microsPerDollar));
  if (!Number.isSafeInteger(micros)) {
    throw new LedgerError(
      "invalid_amount",
      `${dollars} dollars does not convert to an exact micro-dollar amount`,
    );
  }
  return BigInt(micros);
}

// Display only — never feed the result back into the ledger.
export function formatMicros(micros: bigint): string {
  const negative = micros < 0n;
  const absolute = negative ? -micros : micros;
  const whole = absolute / microsPerDollar;
  const fraction = (absolute % microsPerDollar).toString().padStart(6, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

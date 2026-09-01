import { describe, expect, it } from "vitest";
import { dollarsToMicros, formatMicros, parseMicros } from "./money";
import { LedgerError } from "./types";

describe("micro-dollars", () => {
  it("reads amounts out of jsonb payloads", () => {
    expect(parseMicros("575120", "amount")).toBe(575_120n);
    expect(parseMicros(" 10 ", "amount")).toBe(10n);
    expect(parseMicros(-442_400, "amount")).toBe(-442_400n);
    expect(parseMicros(9_007_199_254_740_993n, "amount")).toBe(
      9_007_199_254_740_993n,
    );
  });

  // A float that lost precision on the way in must not be rounded into the
  // books; the payload should have carried a string.
  it("refuses amounts JSON cannot represent exactly", () => {
    expect(() => parseMicros(1.5, "amount")).toThrow(LedgerError);
    expect(() => parseMicros(2 ** 53 + 1, "amount")).toThrow(LedgerError);
    expect(() => parseMicros("1.5", "amount")).toThrow(LedgerError);
    expect(() => parseMicros(null, "amount")).toThrow(/amount/);
  });

  it("converts dollars and formats them back", () => {
    expect(dollarsToMicros(10)).toBe(10_000_000n);
    expect(dollarsToMicros(0.59)).toBe(590_000n);
    expect(formatMicros(575_120n)).toBe("0.575120");
    expect(formatMicros(-10_000_000n)).toBe("-10.000000");
  });
});

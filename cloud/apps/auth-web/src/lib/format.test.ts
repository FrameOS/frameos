import { describe, expect, it } from "vitest";
import { formatBytes, formatMicrosUsd } from "./format";

describe("formatMicrosUsd", () => {
  it("shows whole cents when that is all there is", () => {
    expect(formatMicrosUsd(0n)).toBe("$0.00");
    expect(formatMicrosUsd(10_000_000n)).toBe("$10.00");
    expect(formatMicrosUsd(-590_000n)).toBe("-$0.59");
    expect(formatMicrosUsd(1_234_567_890_000n)).toBe("$1,234,567.89");
  });

  // A metered turn can cost a fraction of a cent. Rounding that away would
  // make a page of them add up to something the ledger does not say.
  it("keeps sub-cent precision when the amount has any", () => {
    expect(formatMicrosUsd(575_120n)).toBe("$0.57512");
    expect(formatMicrosUsd("442400")).toBe("$0.4424");
    expect(formatMicrosUsd(1n)).toBe("$0.000001");
  });

  // bigint does not survive React's server/client boundary, so client props
  // carry the decimal string form.
  it("reads the string form client props carry", () => {
    expect(formatMicrosUsd("")).toBe("$0.00");
    expect(formatMicrosUsd("10000000")).toBe("$10.00");
  });
});

describe("formatBytes", () => {
  it("scales into the largest unit that keeps the number readable", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});

import { describe, expect, it } from "vitest";
import {
  base32Decode,
  base32Encode,
  generateRecoveryCodes,
  generateTotpSecret,
  looksLikeRecoveryCode,
  normalizeRecoveryCode,
  normalizeTotpCode,
  totpCodeAtStep,
  totpProvisioningUri,
  totpStepFor,
  verifyTotpCode,
} from "./two-factor";

// RFC 6238 appendix B test secret ("12345678901234567890") in base32.
const rfcSecret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

describe("TOTP", () => {
  it("round-trips base32", () => {
    const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x01, 0x02, 0x03]);
    const encoded = base32Encode(bytes);
    expect(base32Decode(encoded)).toEqual(Buffer.from(bytes));
    expect(base32Decode(rfcSecret).toString("ascii")).toBe(
      "12345678901234567890",
    );
  });

  it("matches the RFC 6238 SHA-1 vectors (last six digits)", () => {
    // T = 59s → step 1 → 94287082; T = 1111111109 → 07081804; etc.
    expect(totpCodeAtStep(rfcSecret, 1)).toBe("287082");
    expect(totpCodeAtStep(rfcSecret, Math.floor(1111111109 / 30))).toBe(
      "081804",
    );
    expect(totpCodeAtStep(rfcSecret, Math.floor(1234567890 / 30))).toBe(
      "005924",
    );
    expect(totpCodeAtStep(rfcSecret, Math.floor(2000000000 / 30))).toBe(
      "279037",
    );
  });

  it("accepts one step of drift either way and nothing further", () => {
    const now = 1234567890 * 1000;
    const step = totpStepFor(now);
    expect(verifyTotpCode(rfcSecret, totpCodeAtStep(rfcSecret, step), { now })).toBe(step);
    expect(
      verifyTotpCode(rfcSecret, totpCodeAtStep(rfcSecret, step - 1), { now }),
    ).toBe(step - 1);
    expect(
      verifyTotpCode(rfcSecret, totpCodeAtStep(rfcSecret, step + 1), { now }),
    ).toBe(step + 1);
    expect(
      verifyTotpCode(rfcSecret, totpCodeAtStep(rfcSecret, step - 2), { now }),
    ).toBeUndefined();
    expect(verifyTotpCode(rfcSecret, "000000", { now })).toBeUndefined();
  });

  it("refuses a step at or before the last used one (replay)", () => {
    const now = 1234567890 * 1000;
    const step = totpStepFor(now);
    const code = totpCodeAtStep(rfcSecret, step);
    expect(verifyTotpCode(rfcSecret, code, { lastUsedStep: step, now })).toBeUndefined();
    expect(verifyTotpCode(rfcSecret, code, { lastUsedStep: step - 1, now })).toBe(step);
  });

  it("generates 32-char base32 secrets and otpauth URIs", () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    const uri = totpProvisioningUri(secret, "someone@example.com");
    expect(uri.startsWith("otpauth://totp/FrameOS%20Cloud%3Asomeone%40example.com?")).toBe(true);
    expect(uri).toContain(`secret=${secret}`);
    expect(uri).toContain("issuer=FrameOS+Cloud");
  });

  it("normalizes codes with spaces and dashes", () => {
    expect(normalizeTotpCode("123 456")).toBe("123456");
    expect(normalizeTotpCode("123-456")).toBe("123456");
    expect(normalizeTotpCode("12345")).toBeUndefined();
    expect(normalizeTotpCode("abcdef")).toBeUndefined();
    expect(normalizeTotpCode(123456)).toBeUndefined();
  });
});

describe("recovery codes", () => {
  it("generates ten distinct xxxxx-xxxxx codes", () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) {
      expect(code).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}$/);
      expect(looksLikeRecoveryCode(code)).toBe(true);
    }
  });

  it("normalizes case and separators", () => {
    expect(normalizeRecoveryCode("AbCdE-fGh23")).toBe("abcdefgh23");
    expect(looksLikeRecoveryCode("abcde fgh23")).toBe(true);
    expect(looksLikeRecoveryCode("123456")).toBe(false);
  });
});

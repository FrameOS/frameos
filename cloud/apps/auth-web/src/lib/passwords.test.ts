import { describe, expect, it } from "vitest";
import {
  hashPassword,
  validatePasswordCandidate,
  verifyPassword,
  verifyPasswordWithDummyFallback,
} from "./passwords";

describe("passwords", () => {
  it("verifies a password against its own hash", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("correct horse battery staple", hash)).toBe(
      true,
    );
  });

  it("rejects a wrong password", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("incorrect horse", hash)).toBe(false);
  });

  it("produces distinct salted hashes for the same password", async () => {
    const first = await hashPassword("same password");
    const second = await hashPassword("same password");
    expect(first).not.toBe(second);
  });

  it("records the scrypt parameters in the stored hash", async () => {
    const hash = await hashPassword("some password");
    expect(hash).toMatch(/^scrypt\$65536\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
  });

  it("rejects malformed stored hashes without throwing", async () => {
    expect(await verifyPassword("anything", "")).toBe(false);
    expect(await verifyPassword("anything", "bcrypt$whatever")).toBe(false);
    expect(await verifyPassword("anything", "scrypt$x$y$z$aa$bb")).toBe(false);
  });

  it("returns false for missing hashes after burning a dummy verification", async () => {
    expect(await verifyPasswordWithDummyFallback("anything", null)).toBe(false);
    expect(await verifyPasswordWithDummyFallback("anything", undefined)).toBe(
      false,
    );
  });

  it("enforces the password length policy", () => {
    expect(validatePasswordCandidate("short")).toBeDefined();
    expect(validatePasswordCandidate("a".repeat(300))).toBeDefined();
    expect(validatePasswordCandidate("long enough password")).toBeUndefined();
  });
});

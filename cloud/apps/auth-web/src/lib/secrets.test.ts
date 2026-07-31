import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createEncryptedSecretToken,
  createSecretToken,
  decryptSecret,
  encryptSecret,
  hashSecret,
} from "./secrets";

describe("secrets", () => {
  it("hashes secrets without exposing the original value", () => {
    const hash = hashSecret("fc_link_secret");
    expect(hash).not.toContain("fc_link_secret");
    expect(hash).toBe(hashSecret("fc_link_secret"));
  });

  it("encrypts and decrypts link credentials with a 32-byte key", () => {
    const key = randomBytes(32).toString("base64");
    const encrypted = encryptSecret("fc_link_secret", key);

    expect(encrypted).toMatch(/^v1:/);
    expect(decryptSecret(encrypted, key)).toBe("fc_link_secret");
  });

  it("creates prefixed secret tokens", () => {
    expect(createSecretToken("fc_link")).toMatch(/^fc_link_/);
  });

  it("creates distinct encrypted credentials for token rotation", () => {
    const key = randomBytes(32).toString("base64");
    const first = createEncryptedSecretToken("fc_link", key);
    const second = createEncryptedSecretToken("fc_link", key);

    expect(first.token).not.toBe(second.token);
    expect(first.tokenReference).not.toBe(second.tokenReference);
    expect(decryptSecret(first.encryptedToken, key)).toBe(first.token);
    expect(decryptSecret(second.encryptedToken, key)).toBe(second.token);
  });
});

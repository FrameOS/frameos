import { describe, expect, it } from "vitest";
import { sharedKeyAccess, sharedKeyAllowedFor, sharedKeyChatModels } from "./api-key";
import { DEFAULT_CHAT_MODEL } from "./openai";

describe("shared OpenAI key access", () => {
  it("defaults to none and ignores unknown values", () => {
    expect(sharedKeyAccess({})).toBe("none");
    expect(sharedKeyAccess({ FRAMEOS_AI_SHARED_KEY_ACCESS: "everyone" })).toBe("none");
    expect(sharedKeyAccess({ FRAMEOS_AI_SHARED_KEY_ACCESS: " Verified " })).toBe("verified");
  });

  it("gates by account standing", () => {
    const plain = { isSuperadmin: false, verifiedPublisherAt: null };
    const verified = { isSuperadmin: false, verifiedPublisherAt: new Date() };
    const admin = { isSuperadmin: true, verifiedPublisherAt: null };
    expect(sharedKeyAllowedFor(plain, "none")).toBe(false);
    expect(sharedKeyAllowedFor(admin, "none")).toBe(false);
    expect(sharedKeyAllowedFor(plain, "superadmin")).toBe(false);
    expect(sharedKeyAllowedFor(admin, "superadmin")).toBe(true);
    expect(sharedKeyAllowedFor(verified, "superadmin")).toBe(false);
    expect(sharedKeyAllowedFor(verified, "verified")).toBe(true);
    expect(sharedKeyAllowedFor(admin, "verified")).toBe(true);
    expect(sharedKeyAllowedFor(plain, "verified")).toBe(false);
    expect(sharedKeyAllowedFor(plain, "all")).toBe(true);
  });

  it("keeps the shared key on the default model unless the operator lists more", () => {
    expect([...sharedKeyChatModels({})]).toEqual([DEFAULT_CHAT_MODEL]);
    const widened = sharedKeyChatModels({ FRAMEOS_AI_SHARED_KEY_MODELS: " gpt-5.5, ,gpt-6-luna " });
    expect(widened.has(DEFAULT_CHAT_MODEL)).toBe(true);
    expect(widened.has("gpt-5.5")).toBe(true);
    expect(widened.has("gpt-6-luna")).toBe(true);
    expect(widened.has("o9-pro")).toBe(false);
  });
});

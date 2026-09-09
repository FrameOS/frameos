import { describe, expect, it } from "vitest";
import {
  boundMessageForStorage,
  maxMessageContentBytes,
  maxMessagePayloadBytes,
} from "./chat-store";

describe("boundMessageForStorage", () => {
  it("stores an ordinary message untouched", () => {
    const bounded = boundMessageForStorage({
      content: "Done.",
      payload: { scenes: [{ id: "a" }] },
      role: "assistant",
    });
    expect(bounded).toEqual({
      content: "Done.",
      payload: { scenes: [{ id: "a" }] },
      truncated: false,
    });
    expect(boundMessageForStorage({ content: "hi", role: "user" }).payload).toBeNull();
  });

  it("replaces an oversize payload with a marker and cuts oversize text", () => {
    const payload = { scenes: [{ blob: "x".repeat(maxMessagePayloadBytes) }] };
    const bounded = boundMessageForStorage({
      content: "y".repeat(maxMessageContentBytes + 10),
      payload,
      role: "assistant",
    });
    expect(bounded.truncated).toBe(true);
    expect(bounded.payload).toMatchObject({ max_bytes: maxMessagePayloadBytes, truncated: true });
    expect(Buffer.byteLength(bounded.content)).toBeLessThan(maxMessageContentBytes + 64);
    expect(bounded.content.endsWith("[message truncated]")).toBe(true);
  });
});

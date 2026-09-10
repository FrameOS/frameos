import { describe, expect, it } from "vitest";
import {
  boundMessageForStorage,
  deriveChatTitle,
  isForeignKeyViolation,
  maxChatTitleChars,
  maxMessageContentBytes,
  maxMessagePayloadBytes,
} from "./chat-store";

describe("deriveChatTitle", () => {
  it("uses a short first message as is, collapsed to one line", () => {
    expect(deriveChatTitle("  Make a\n clock   scene ")).toBe("Make a clock scene");
  });

  it("cuts a long message at a word boundary with an ellipsis", () => {
    const title = deriveChatTitle("Build me a weather dashboard that shows the forecast for the next three days with icons");
    expect(title).toBe("Build me a weather dashboard that shows the forecast for the…");
    expect(deriveChatTitle("Build me a weather dashboard that shows the forecast for thenext three days")).toBe(
      "Build me a weather dashboard that shows the forecast for…",
    );
    expect(title!.length).toBeLessThanOrEqual(maxChatTitleChars + 1);
  });

  it("cuts inside a word when there is no usable boundary", () => {
    expect(deriveChatTitle("x".repeat(100))).toBe(`${"x".repeat(maxChatTitleChars)}…`);
  });

  it("is null for an empty message", () => {
    expect(deriveChatTitle("   \n")).toBeNull();
  });
});

describe("isForeignKeyViolation", () => {
  it("recognises SQLSTATE 23503 and nothing else", () => {
    expect(isForeignKeyViolation(Object.assign(new Error("fk"), { code: "23503" }))).toBe(true);
    expect(
      isForeignKeyViolation(new Error("Failed query", { cause: Object.assign(new Error("fk"), { code: "23503" }) })),
    ).toBe(true);
    expect(isForeignKeyViolation(Object.assign(new Error("unique"), { code: "23505" }))).toBe(false);
    expect(isForeignKeyViolation(new Error("plain"))).toBe(false);
    expect(isForeignKeyViolation(null)).toBe(false);
  });
});

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

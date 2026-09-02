import { describe, expect, it } from "vitest";
import { boundHistory, maxHistoryItemChars, maxHistoryTotalChars } from "./chat-store";

// The history a chat feeds back into the model is the one input a client can
// grow turn after turn; it is cut per item and bounded as a whole, newest
// turns kept.
describe("boundHistory", () => {
  it("leaves a small history alone", () => {
    const history = [
      { content: "hi", role: "user" as const },
      { content: "hello", role: "assistant" as const },
    ];
    expect(boundHistory(history)).toEqual(history);
  });

  it("cuts an oversized item and marks the cut", () => {
    const [item] = boundHistory([{ content: "x".repeat(maxHistoryItemChars + 1), role: "user" }]);
    expect(item?.content.length).toBeLessThan(maxHistoryItemChars + 20);
    expect(item?.content.endsWith("…(truncated)")).toBe(true);
  });

  it("drops the oldest items once the window is full", () => {
    const items = Array.from({ length: 12 }, (_, index) => ({
      content: `${index}:${"y".repeat(maxHistoryItemChars - 3)}`,
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
    }));
    const bounded = boundHistory(items);
    const total = bounded.reduce((sum, item) => sum + item.content.length, 0);
    expect(total).toBeLessThanOrEqual(maxHistoryTotalChars + bounded.length * 20);
    expect(bounded.length).toBeLessThan(items.length);
    // Newest last, and kept.
    expect(bounded.at(-1)?.content.startsWith("11:")).toBe(true);
    expect(bounded[0]?.content.startsWith("0:")).toBe(false);
  });
});

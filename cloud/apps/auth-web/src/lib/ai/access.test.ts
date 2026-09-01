import { describe, expect, it } from "vitest";
import { aiRefusalResponse } from "./access";
import type { AiRefusal } from "./api-key";

async function body(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

// Three refusals that used to collapse into one `missing_api_key`, and the
// whole point of splitting them is that each needs a different next action
// from the person who hit it (cloud/docs/accounting-todo.md §5.1, §5.3).
describe("AI refusal responses", () => {
  it("reports a switched-off account as forbidden, not as a missing key", async () => {
    const response = aiRefusalResponse({
      detail: "AI features are switched off for this account.",
      reason: "ai_disabled",
    });
    expect(response.status).toBe(403);
    expect(await body(response)).toMatchObject({ error: "ai_disabled" });
  });

  // 402 and not 429: this is a spending limit, not a rate limit, and the
  // body carries everything a panel needs to say when it comes back.
  it("reports the daily cap with the numbers behind it", async () => {
    const refusal: AiRefusal = {
      capMicros: "10000000",
      detail: "This account has reached its daily AI limit.",
      reason: "daily_cap_reached",
      resetAt: "2026-09-02T00:00:00.000Z",
      spentMicros: "10500000",
    };
    const response = aiRefusalResponse(refusal);
    expect(response.status).toBe(402);
    expect(await body(response)).toMatchObject({
      cap_micros: "10000000",
      error: "daily_cap_reached",
      reset_at: "2026-09-02T00:00:00.000Z",
      spent_micros: "10500000",
    });
  });

  it("still reports a genuinely missing key the way it always did", async () => {
    const response = aiRefusalResponse({
      detail: "OpenAI backend API key not set",
      reason: "missing_api_key",
    });
    expect(response.status).toBe(400);
    expect(await body(response)).toMatchObject({ error: "missing_api_key" });
  });
});

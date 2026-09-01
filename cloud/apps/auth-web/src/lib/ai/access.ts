import { jsonError } from "../device-flow";
import type { AiRefusal } from "./api-key";

// The HTTP half of the AI access gate (cloud/docs/accounting-todo.md §5.1,
// §5.3). Kept apart from api-key.ts so that module stays free of Next types
// and can be called from a script or a test without a request in hand.

// One refusal, three meanings, three status codes: a switch the user threw
// (403 — nothing is broken, they asked for this), a cap they will be under
// again tomorrow (402 — the payment-shaped one), and no key at all (400 —
// the original meaning of a null credential). Collapsing them is how a user
// ends up guessing which of three unrelated things went wrong.
export function aiRefusalResponse(refusal: AiRefusal) {
  if (refusal.reason === "ai_disabled") {
    return jsonError("ai_disabled", 403, { detail: refusal.detail });
  }
  if (refusal.reason === "daily_cap_reached") {
    return jsonError("daily_cap_reached", 402, {
      cap_micros: refusal.capMicros,
      detail: refusal.detail,
      reset_at: refusal.resetAt,
      spent_micros: refusal.spentMicros,
    });
  }
  return jsonError("missing_api_key", 400, { detail: refusal.detail });
}

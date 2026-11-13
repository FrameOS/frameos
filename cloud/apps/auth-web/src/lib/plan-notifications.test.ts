import { describe, expect, it } from "vitest";
import { statusNoticeFor } from "./billing-provider";
import { planEventCapture, planEvents, type PlanNotice } from "./plan-notifications";

const plan = (code: string, name: string, dollars: number) => ({
  code,
  currency: "USD",
  name,
  period: "month",
  priceMicros: BigInt(dollars * 1_000_000),
});
const private5 = plan("private-5", "Private", 5);
const private9 = plan("private-9", "Private", 9);
const base = { accountId: "6c1f8a4e-1b7a-4c7e-9a52-0f3c2b1d4e5f", mode: "live" as const, subscriptionId: "sub_1" };

function capture(notice: PlanNotice) {
  const { event, properties } = planEventCapture(notice);
  return { event, summary: properties["summary"], properties };
}

describe("planEventCapture", () => {
  const payment = {
    ...base,
    amountCents: 605,
    billingReason: "subscription_create",
    currency: "USD",
    invoiceId: "in_1",
    kind: "payment" as const,
    plan: private5,
    taxCents: 105,
  };

  it("tells a first purchase, a renewal, a change and anything else apart by the plan before", () => {
    expect(capture({ ...payment, previous: null })).toMatchObject({
      event: planEvents.subscribed,
      summary: "🎉 New subscription: Private $5/month, $6.05 paid incl. $1.05 tax",
    });
    expect(capture({ ...payment, billingReason: "subscription_cycle", previous: private5 })).toMatchObject({
      event: planEvents.renewed,
      summary: "🔁 Renewal: Private $5/month, $6.05 paid incl. $1.05 tax",
    });
    expect(capture({ ...payment, billingReason: "subscription_update", plan: private9, previous: private5 }))
      .toMatchObject({
        event: planEvents.changed,
        summary: "⬆️ Upgrade: Private $5/month → Private $9/month, $6.05 paid incl. $1.05 tax",
      });
    expect(capture({ ...payment, billingReason: "subscription_cycle", plan: private5, previous: private9 }))
      .toMatchObject({ event: planEvents.changed, summary: expect.stringMatching(/^⬇️ Downgrade/) });
    expect(capture({ ...payment, billingReason: "manual", previous: private5, taxCents: 0 })).toMatchObject({
      event: planEvents.paymentReceived,
      summary: "💶 Payment: Private $5/month, $6.05 paid (manual)",
    });
  });

  it("keeps the money as numbers, links the customer statement and names nobody", () => {
    const { properties } = capture({ ...payment, previous: null });
    expect(properties).toMatchObject({
      amount: 6.05,
      billing_reason: "subscription_create",
      currency: "USD",
      invoice_id: "in_1",
      mode: "live",
      plan_code: "private-5",
      plan_name: "Private",
      provider: "stripe",
      subscription_id: "sub_1",
      tax: 1.05,
    });
    expect(String(properties["admin_url"])).toMatch(
      /\/admin\/billing\/customers\?account=6c1f8a4e-1b7a-4c7e-9a52-0f3c2b1d4e5f$/,
    );
  });

  it("marks a test-mode notice as an operator's check", () => {
    expect(capture({ ...payment, mode: "test", previous: null }).summary).toMatch(/^\[test\] 🎉 New subscription/);
  });

  it("says when a cancellation ends and why a plan ended", () => {
    const at = new Date("2026-12-10T08:00:00Z");
    expect(capture({ ...base, at, kind: "cancellation_scheduled", plan: private5 })).toMatchObject({
      event: planEvents.cancellationScheduled,
      summary: "👋 Cancellation: Private $5/month ends 2026-12-10",
    });
    expect(capture({ ...base, kind: "cancellation_withdrawn", plan: private5 }).event).toBe(
      planEvents.cancellationWithdrawn,
    );
    expect(capture({ ...base, kind: "ended", plan: private5, reason: "payment_failed" })).toMatchObject({
      event: planEvents.ended,
      summary: "🛑 Plan ended: Private $5/month, Stripe gave up on the card",
    });
    expect(capture({ ...base, at, kind: "downgrade_scheduled", plan: private5, previous: private9 })).toMatchObject({
      event: planEvents.downgradeScheduled,
      summary: "↘️ Downgrade scheduled: Private $9/month → Private $5/month on 2026-12-10",
    });
  });

  it("puts refunds and disputes in the plan's currency", () => {
    const money = { amountCents: 1089, currency: "EUR", plan: private9 };
    expect(capture({ ...base, ...money, kind: "refunded", refundId: "re_1" }).summary).toBe(
      "💸 Refund: €10.89 on Private $9/month",
    );
    expect(capture({ ...base, ...money, disputeId: "dp_1", kind: "dispute_opened", reason: "fraudulent" }).summary)
      .toBe("🚨 Dispute opened: €10.89 on Private $9/month (fraudulent). Answer it in Stripe before its deadline.");
    expect(capture({ ...base, ...money, disputeId: "dp_1", kind: "dispute_closed", status: "lost" }).summary).toBe(
      "⚖️ Dispute lost: €10.89 on Private $9/month",
    );
  });
});

describe("statusNoticeFor", () => {
  it("reports a cancellation, its withdrawal, a failing card and an end", () => {
    expect(statusNoticeFor("active", "scheduled_cancel")).toBe("cancellation_scheduled");
    expect(statusNoticeFor("scheduled_cancel", "active")).toBe("cancellation_withdrawn");
    expect(statusNoticeFor("active", "past_due")).toBe("payment_failed");
    expect(statusNoticeFor("scheduled_cancel", "canceled")).toBe("ended_scheduled");
    expect(statusNoticeFor("past_due", "canceled")).toBe("ended_payment_failed");
    expect(statusNoticeFor("unpaid", "canceled")).toBe("ended_payment_failed");
    expect(statusNoticeFor("active", "canceled")).toBe("ended_canceled");
  });

  it("stays quiet about a checkout that never paid and a card that keeps failing", () => {
    expect(statusNoticeFor("incomplete", "incomplete_expired")).toBeNull();
    expect(statusNoticeFor("incomplete", "active")).toBeNull();
    expect(statusNoticeFor("past_due", "unpaid")).toBeNull();
    // The renewal's payment says it.
    expect(statusNoticeFor("past_due", "active")).toBeNull();
    expect(statusNoticeFor("canceled", "canceled")).toBeNull();
  });
});

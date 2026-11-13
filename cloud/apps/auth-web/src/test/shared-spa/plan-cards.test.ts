// @vitest-environment jsdom
// The Usage page's plan cards (frontend/src/scenes/settings/account/plansLogic.ts)
// over the catalog the cloud serves (src/lib/plan-catalog.ts).
import { describe, expect, it } from "vitest";
import {
  planCardsFor,
  wholeDollars,
  type PlanBilling,
  type PlanCatalog,
} from "../../../../../../frontend/src/scenes/settings/account/plansLogic";
import { planCatalog } from "../../lib/plan-catalog";

const megabyte = 1024 * 1024;
const catalog: PlanCatalog = planCatalog(
  {
    backupBytes: 100 * megabyte,
    cloudRenderedFrames: 0,
    frameLogBytes: 100 * megabyte,
    frames: 20,
    photoBytes: 250 * megabyte,
    privateSceneBytes: 100 * megabyte,
  },
  "payg",
);

describe("the plan cards", () => {
  it("starts each slider at its cheapest stop and shows Free as the account's plan", () => {
    const cards = planCardsFor(catalog, {}, "support@example.com");
    expect(cards.map((card) => [card.group.key, wholeDollars(card.stop.price_micros), card.current])).toEqual([
      ["free", "$0", true],
      ["private", "$2", false],
      ["business", "$49", false],
    ]);
  });

  it("follows the slider and keeps it on the stops", () => {
    const cards = planCardsFor(catalog, { business: 99, private: 2 }, null);
    expect(wholeDollars(cards[1]!.stop.price_micros)).toBe("$9");
    expect(cards[2]!.stopIndex).toBe(catalog.groups[2]!.stops.length - 1);
    expect(wholeDollars(cards[2]!.stop.price_micros)).toBe("$499");
  });

  it("lists what a card adds over the one before it, and what a bigger stop would add", () => {
    const [free, privatePlan, business] = planCardsFor(catalog, {}, null);
    expect(free!.features).toEqual([]);
    expect(privatePlan!.features).toEqual(["share_frames", "virtual_frames"]);
    expect(business!.features).toEqual(["sso", "priority_support"]);
    expect(business!.laterFeatures).toEqual([{ feature: "dedicated_support", priceMicros: "499000000" }]);

    const top = planCardsFor(catalog, { business: 5 }, null)[2]!;
    expect(top.features).toEqual(["sso", "priority_support", "dedicated_support"]);
    expect(top.laterFeatures).toEqual([]);
  });

  it("asks support to activate the paid plans, naming the stop", () => {
    const cards = planCardsFor(catalog, { private: 3 }, "support@example.com");
    expect(cards[0]!.contactHref).toBeNull();
    expect(cards[1]!.contactHref).toBe(
      `mailto:support@example.com?subject=${encodeURIComponent("Activate Private at $29/month")}`,
    );
    // Without a support address the card says so in words instead.
    expect(planCardsFor(catalog, {}, null)[1]!.contactHref).toBeNull();
  });
});

describe("what a plan card's button does", () => {
  const megabytes = 1024 * 1024;
  const free = {
    backupBytes: 100 * megabytes,
    cloudRenderedFrames: 0,
    frameLogBytes: 100 * megabytes,
    frames: 20,
    photoBytes: 250 * megabytes,
    privateSceneBytes: 100 * megabytes,
  };
  const buyable = new Set([
    "private-2",
    "private-5",
    "private-9",
    "private-29",
    "business-49",
    "business-99",
    "business-199",
    "business-499",
  ]);
  const billing = (subscription: PlanBilling["subscription"] = null): PlanBilling => ({
    checkout: true,
    manage: subscription !== null,
    mode: "test",
    subscription,
  });
  const paying = (overrides: Partial<NonNullable<PlanBilling["subscription"]>> = {}) =>
    billing({
      cancel_at: null,
      past_due: false,
      plan_code: "private-5",
      renews_at: "2026-12-05T10:00:00.000Z",
      status: "active",
      ...overrides,
    });
  const kinds = (cards: ReturnType<typeof planCardsFor>) => cards.map((card) => card.action.kind);

  it("sends a free account to checkout for Private and for Business", () => {
    const cards = planCardsFor(planCatalog(free, "payg", buyable), {}, "support@example.com", billing());
    expect(kinds(cards)).toEqual(["current", "checkout", "checkout"]);
    expect(cards[1]!.contactHref).toBeNull();
    expect(cards[2]!.contactHref).toBeNull();
  });

  it("asks support for a stop that has no price at the provider yet", () => {
    const privateOnly = new Set(["private-2", "private-5", "private-9", "private-29"]);
    const cards = planCardsFor(planCatalog(free, "payg", privateOnly), {}, "support@example.com", billing());
    expect(kinds(cards)).toEqual(["current", "checkout", "contact"]);
    expect(cards[2]!.contactHref).toContain("mailto:support@example.com");
  });

  it("asks support for everything when no card can be charged", () => {
    const cards = planCardsFor(planCatalog(free, "payg"), {}, "support@example.com", {
      checkout: false,
      manage: false,
      mode: null,
      subscription: null,
    });
    expect(kinds(cards)).toEqual(["current", "contact", "contact"]);
  });

  it("lets a paying account move between stops, and cancel from the Free card", () => {
    const paid = planCatalog(free, "private-5", buyable);
    // The slider opens on the account's stop.
    const onPlan = planCardsFor(paid, {}, null, paying());
    // Business is a larger plan on the same subscription.
    expect(kinds(onPlan)).toEqual(["cancel", "current", "switch"]);
    expect(onPlan[2]!.action).toEqual({ dearer: true, kind: "switch" });
    expect(onPlan[1]!.stop.code).toBe("private-5");

    const larger = planCardsFor(paid, { private: 2 }, null, paying())[1]!;
    expect(larger.action).toEqual({ dearer: true, kind: "switch" });
    const smaller = planCardsFor(paid, { private: 0 }, null, paying())[1]!;
    expect(smaller.action).toEqual({ dearer: false, kind: "switch" });
  });

  it("offers to keep a plan that is set to end", () => {
    const ending = paying({ cancel_at: "2026-12-05T10:00:00.000Z", renews_at: null, status: "scheduled_cancel" });
    const cards = planCardsFor(planCatalog(free, "private-5", buyable), {}, null, ending);
    expect(cards[0]!.action).toEqual({ endsAt: "2026-12-05T10:00:00.000Z", kind: "ending" });
    expect(cards[1]!.action).toEqual({ endsAt: "2026-12-05T10:00:00.000Z", kind: "keep" });
  });

  it("marks what is planned on each card", () => {
    const cards = planCardsFor(planCatalog(free, "payg", buyable), {}, null, billing());
    expect(cards.map((card) => card.plannedFeatures)).toEqual([
      [],
      expect.arrayContaining(["share_frames"]),
      expect.arrayContaining(["sso"]),
    ]);
    expect(cards[2]!.plannedFeatures).not.toContain("priority_support");
    // Built: a card offers virtual frames without the "planned" mark.
    expect(cards[1]!.features).toContain("virtual_frames");
    expect(cards[1]!.plannedFeatures).not.toContain("virtual_frames");
  });
});

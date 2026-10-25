// @vitest-environment jsdom
// The Usage page's plan cards (frontend/src/scenes/settings/account/plansLogic.ts)
// over the catalog the cloud serves (src/lib/plan-catalog.ts).
import { describe, expect, it } from "vitest";
import {
  planCardsFor,
  wholeDollars,
  type PlanCatalog,
} from "../../../../../../frontend/src/scenes/settings/account/plansLogic";
import { planCatalog } from "../../lib/plan-catalog";

const megabyte = 1024 * 1024;
const catalog: PlanCatalog = planCatalog(
  {
    backupBytes: 100 * megabyte,
    cloudRenderedFrames: 0,
    frameLogBytes: 100 * megabyte,
    frames: 50,
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
      ["plus", "$2", false],
      ["business", "$10", false],
    ]);
  });

  it("follows the slider and keeps it on the stops", () => {
    const cards = planCardsFor(catalog, { business: 99, plus: 2 }, null);
    expect(wholeDollars(cards[1]!.stop.price_micros)).toBe("$5");
    expect(cards[2]!.stopIndex).toBe(catalog.groups[2]!.stops.length - 1);
    expect(wholeDollars(cards[2]!.stop.price_micros)).toBe("$499");
  });

  it("lists what a card adds over the one before it, and what a bigger stop would add", () => {
    const [free, plus, business] = planCardsFor(catalog, {}, null);
    expect(free!.features).toEqual([]);
    expect(plus!.features).toEqual(["share_frames", "virtual_frames"]);
    expect(business!.features).toEqual(["sso", "priority_support"]);
    expect(business!.laterFeatures).toEqual([{ feature: "dedicated_support", priceMicros: "499000000" }]);

    const top = planCardsFor(catalog, { business: 5 }, null)[2]!;
    expect(top.features).toEqual(["sso", "priority_support", "dedicated_support"]);
    expect(top.laterFeatures).toEqual([]);
  });

  it("asks support to activate the paid plans, naming the stop", () => {
    const cards = planCardsFor(catalog, { plus: 3 }, "support@example.com");
    expect(cards[0]!.contactHref).toBeNull();
    expect(cards[1]!.contactHref).toBe(
      `mailto:support@example.com?subject=${encodeURIComponent("Activate Plus at $10/month")}`,
    );
    // Without a support address the card says so in words instead.
    expect(planCardsFor(catalog, {}, null)[1]!.contactHref).toBeNull();
  });
});

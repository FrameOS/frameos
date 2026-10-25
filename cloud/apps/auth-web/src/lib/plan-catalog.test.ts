import { describe, expect, it } from "vitest";
import { catalogLimits, planCatalog, planGroups } from "./plan-catalog";
import type { PlanLimits } from "./usage";

const megabyte = 1024 * 1024;
const free: PlanLimits = {
  backupBytes: 100 * megabyte,
  cloudRenderedFrames: 0,
  frameLogBytes: 100 * megabyte,
  frames: 50,
  photoBytes: 250 * megabyte,
  privateSceneBytes: 100 * megabyte,
};

describe("the plan catalog", () => {
  it("slides Plus from $2 to $49 and Business from $10 to $499", () => {
    const prices = Object.fromEntries(planGroups.map((group) => [group.key, group.pricesUsd]));
    expect(prices.free).toEqual([0]);
    for (const key of ["plus", "business"]) {
      const stops = prices[key] ?? [];
      expect([...stops].sort((a, b) => a - b)).toEqual(stops);
      expect(new Set(stops).size).toBe(stops.length);
    }
    expect(prices.plus?.[0]).toBe(2);
    expect(prices.plus?.at(-1)).toBe(49);
    expect(prices.business?.[0]).toBe(10);
    expect(prices.business?.at(-1)).toBe(499);
  });

  it("makes $2 two people and twice everything else", () => {
    expect(catalogLimits(free, 0)).toEqual({ ...free, people: 1 });
    expect(catalogLimits(free, 2)).toEqual({
      backupBytes: 200 * megabyte,
      cloudRenderedFrames: 2,
      frameLogBytes: 200 * megabyte,
      frames: 100,
      people: 2,
      photoBytes: 500 * megabyte,
      privateSceneBytes: 200 * megabyte,
    });
  });

  it("adds features by group, and dedicated support only at $499", () => {
    const catalog = planCatalog(free, "payg");
    const [freeGroup, plus, business] = catalog.groups;
    expect(freeGroup?.stops.map((stop) => stop.features)).toEqual([[]]);
    for (const stop of plus?.stops ?? []) {
      expect(stop.features).toEqual(["share_frames", "virtual_frames"]);
    }
    const dedicated = (business?.stops ?? [])
      .filter((stop) => stop.features.includes("dedicated_support"))
      .map((stop) => stop.code);
    expect(dedicated).toEqual(["business-499"]);
    expect(business?.stops[0]?.features).toEqual(["share_frames", "virtual_frames", "sso", "priority_support"]);
  });

  it("marks the account's plan and only lets Free be chosen", () => {
    const catalog = planCatalog(free, "payg");
    expect(catalog.groups.map((group) => group.available)).toEqual([true, false, false]);
    const current = catalog.groups.flatMap((group) => group.stops).filter((stop) => stop.current);
    expect(current.map((stop) => stop.code)).toEqual(["payg"]);
    // An account support moved onto a paid stop sees that card as its own.
    const moved = planCatalog(free, "plus-5").groups.flatMap((group) => group.stops);
    expect(moved.filter((stop) => stop.current).map((stop) => stop.code)).toEqual(["plus-5"]);
    expect(moved.find((stop) => stop.code === "plus-5")?.price_micros).toBe("5000000");
  });
});

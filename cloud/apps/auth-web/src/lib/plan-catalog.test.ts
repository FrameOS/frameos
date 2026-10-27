import { describe, expect, it } from "vitest";
import { catalogLimits, planCatalog, planGroups } from "./plan-catalog";
import type { PlanLimits } from "./usage";

const megabyte = 1024 * 1024;
const free: PlanLimits = {
  backupBytes: 100 * megabyte,
  cloudRenderedFrames: 0,
  frameLogBytes: 100 * megabyte,
  frames: 20,
  photoBytes: 250 * megabyte,
  privateSceneBytes: 100 * megabyte,
};

describe("the plan catalog", () => {
  it("slides Private from $2 to $29 and Business from $49 to $499", () => {
    const prices = Object.fromEntries(planGroups.map((group) => [group.key, group.stops.map((stop) => stop.usd)]));
    expect(prices.free).toEqual([0]);
    for (const key of ["private", "business"]) {
      const stops = prices[key] ?? [];
      expect([...stops].sort((a, b) => a - b)).toEqual(stops);
      expect(new Set(stops).size).toBe(stops.length);
    }
    expect(prices.private?.[0]).toBe(2);
    expect(prices.private?.at(-1)).toBe(29);
    expect(prices.business?.[0]).toBe(49);
    expect(prices.business?.at(-1)).toBe(499);
  });

  it("makes $2 two people and twice everything else", () => {
    expect(catalogLimits(free, { usd: 0 })).toEqual({ ...free, people: 1 });
    expect(catalogLimits(free, { frames: 40, usd: 2 })).toEqual({
      backupBytes: 200 * megabyte,
      cloudRenderedFrames: 2,
      frameLogBytes: 200 * megabyte,
      frames: 40,
      people: 2,
      photoBytes: 500 * megabyte,
      privateSceneBytes: 200 * megabyte,
    });
  });

  it("grows frames slower than the price", () => {
    const stops = planCatalog(free, "payg").groups.flatMap((group) => group.stops);
    expect(stops.map((stop) => [Number(stop.price_micros) / 1_000_000, stop.limits.frames])).toEqual([
      [0, 20],
      [2, 40],
      [9, 80],
      [29, 160],
      [49, 199],
      [99, 299],
      [199, 499],
      [499, 999],
    ]);
    // Storage still scales with the price.
    expect(stops.at(-1)?.limits.photo_bytes).toBe(499 * free.photoBytes);
    // A deployment whose free plan holds more never shows a paid stop below it.
    const roomy = planCatalog({ ...free, frames: 100 }, "payg").groups[1]?.stops[0];
    expect(roomy?.limits.frames).toBe(100);
  });

  it("adds features by group, and dedicated support only at $499", () => {
    const catalog = planCatalog(free, "payg");
    const [freeGroup, privatePlan, business] = catalog.groups;
    expect(freeGroup?.stops.map((stop) => stop.features)).toEqual([[]]);
    for (const stop of privatePlan?.stops ?? []) {
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
    const moved = planCatalog(free, "private-9").groups.flatMap((group) => group.stops);
    expect(moved.filter((stop) => stop.current).map((stop) => stop.code)).toEqual(["private-9"]);
    expect(moved.find((stop) => stop.code === "private-9")?.price_micros).toBe("9000000");
  });
});

// The plans the usage page offers (cloud/docs/accounting-todo.md §0.1):
// Free, Plus and Business. One rule sets every number: a paid plan at $N a
// month is N people, N virtual frames, and N times the free plan's frames
// and storage. Business has the same numbers at the same price and adds its
// own features, so the higher tiers buy capacity, never features.
//
// Only Free is live. Support activates a paid tier by giving the account a
// billing_plans row with the stop's code and these limits as entitlements
// (photo_bytes included), so the page, the row and the quota refusals read
// the same numbers.

import { paygPlanCode } from "@frameos-cloud/ledger";
import type { PlanLimits } from "./usage";

export type PlanFeature =
  | "share_frames"
  | "virtual_frames"
  | "sso"
  | "priority_support"
  | "dedicated_support";

export type PlanGroupKey = "free" | "plus" | "business";

interface PlanGroupDefinition {
  // Features every stop of the group has.
  features: PlanFeature[];
  // Features a stop has from this monthly price up.
  featuresFrom?: { feature: PlanFeature; usd: number }[];
  key: PlanGroupKey;
  name: string;
  // The slider's stops, in whole dollars a month.
  pricesUsd: number[];
}

export const planGroups: PlanGroupDefinition[] = [
  { features: [], key: "free", name: "Free", pricesUsd: [0] },
  {
    features: ["share_frames", "virtual_frames"],
    key: "plus",
    name: "Plus",
    pricesUsd: [2, 3, 5, 10, 20, 49],
  },
  {
    features: ["share_frames", "virtual_frames", "sso", "priority_support"],
    featuresFrom: [{ feature: "dedicated_support", usd: 499 }],
    key: "business",
    name: "Business",
    pricesUsd: [10, 25, 49, 99, 199, 499],
  },
];

export interface CatalogLimits extends PlanLimits {
  people: number;
}

/** The numbers a plan at `usd` a month comes with, from the free plan's. */
export function catalogLimits(free: PlanLimits, usd: number): CatalogLimits {
  if (usd <= 0) {
    return { ...free, people: 1 };
  }
  return {
    backupBytes: free.backupBytes * usd,
    cloudRenderedFrames: usd,
    frameLogBytes: free.frameLogBytes * usd,
    frames: free.frames * usd,
    people: usd,
    photoBytes: free.photoBytes * usd,
    privateSceneBytes: free.privateSceneBytes * usd,
  };
}

export function catalogPlanCode(group: PlanGroupKey, usd: number): string {
  return usd <= 0 ? paygPlanCode : `${group}-${usd}`;
}

/**
 * The catalog in the wire shape (snake_case, string prices: it crosses the
 * AGPL boundary like every account payload). `free` is what the free plan
 * comes to on this deployment, `currentPlanCode` the account's plan.
 */
export function planCatalog(free: PlanLimits, currentPlanCode: string) {
  return {
    groups: planGroups.map((group) => ({
      // False: "contact support to activate".
      available: group.key === "free",
      key: group.key,
      name: group.name,
      stops: group.pricesUsd.map((usd) => {
        const code = catalogPlanCode(group.key, usd);
        const limits = catalogLimits(free, usd);
        return {
          code,
          current: code === currentPlanCode,
          features: [
            ...group.features,
            ...(group.featuresFrom ?? []).filter((extra) => usd >= extra.usd).map((extra) => extra.feature),
          ],
          limits: {
            backup_bytes: limits.backupBytes,
            cloud_rendered_frames: limits.cloudRenderedFrames,
            frame_log_bytes: limits.frameLogBytes,
            frames: limits.frames,
            people: limits.people,
            photo_bytes: limits.photoBytes,
            private_scene_bytes: limits.privateSceneBytes,
          },
          price_micros: (BigInt(usd) * 1_000_000n).toString(),
        };
      }),
    })),
  };
}

export type PlanCatalog = ReturnType<typeof planCatalog>;

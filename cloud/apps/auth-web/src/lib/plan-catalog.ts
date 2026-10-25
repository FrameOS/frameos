// The plans the usage page offers (cloud/docs/accounting-todo.md §0.1):
// Free, Private and Business. A paid plan at $N a month is N people, N
// virtual frames and N times the free plan's storage. Frames grow slower,
// by a count each stop names: 40 at $2 but 199 at $49, not 980. Business
// follows the same rules from $49 up and adds its own features, so the
// higher tiers buy capacity, never features.
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

export type PlanGroupKey = "free" | "private" | "business";

export interface PlanStopDefinition {
  // Frames of your own hardware. Free has none of its own: it is the
  // deployment's number, and no paid stop shows less than that.
  frames?: number;
  // Whole dollars a month.
  usd: number;
}

interface PlanGroupDefinition {
  // Features every stop of the group has.
  features: PlanFeature[];
  // Features a stop has from this monthly price up.
  featuresFrom?: { feature: PlanFeature; usd: number }[];
  key: PlanGroupKey;
  name: string;
  // The slider's stops, cheapest first.
  stops: PlanStopDefinition[];
}

export const planGroups: PlanGroupDefinition[] = [
  { features: [], key: "free", name: "Free", stops: [{ usd: 0 }] },
  {
    features: ["share_frames", "virtual_frames"],
    key: "private",
    name: "Private",
    stops: [
      { frames: 40, usd: 2 },
      { frames: 80, usd: 9 },
      { frames: 160, usd: 29 },
    ],
  },
  {
    features: ["share_frames", "virtual_frames", "sso", "priority_support"],
    featuresFrom: [{ feature: "dedicated_support", usd: 499 }],
    key: "business",
    name: "Business",
    stops: [
      { frames: 199, usd: 49 },
      { frames: 299, usd: 99 },
      { frames: 499, usd: 199 },
      { frames: 999, usd: 499 },
    ],
  },
];

export interface CatalogLimits extends PlanLimits {
  people: number;
}

/** The numbers a stop comes with, from the free plan's. */
export function catalogLimits(free: PlanLimits, { frames, usd }: PlanStopDefinition): CatalogLimits {
  if (usd <= 0) {
    return { ...free, people: 1 };
  }
  return {
    backupBytes: free.backupBytes * usd,
    cloudRenderedFrames: usd,
    frameLogBytes: free.frameLogBytes * usd,
    frames: Math.max(free.frames, frames ?? 0),
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
      stops: group.stops.map((stop) => {
        const { usd } = stop;
        const code = catalogPlanCode(group.key, usd);
        const limits = catalogLimits(free, stop);
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

// The plans the usage page offers (cloud/docs/accounting-todo.md §0.1):
// Free, Private and Business. A paid plan at $N a month is N people, N
// virtual frames and N times the free plan's storage. Frames grow slower,
// by a count each stop names: 40 at $2 but 199 at $49, not 980. Business
// follows the same rules from $49 up and adds its own features, so the
// higher tiers buy capacity, never features.
//
// A self-serve group (Private and Business) is bought through Stripe
// (cloud/docs/billing.md):
// each of its stops gets a billing_plans row with the stop's code and these
// limits as entitlements, and a monthly price at Stripe, both written by
// the admin's "Sync plans" (planRowFor, plan-rows.ts, billing-provider.ts).
// The other groups are activated by support. The page, the row and the quota
// refusals read the same numbers.
//
// What a plan lists is what it has today. A feature or limit that is not
// built yet is named in `plannedFeatures` / `plannedLimits`: every page
// marks it "planned", and a plan's row does not grant it. Take a name off
// those lists in the change that ships the feature.

import { paygPlanCode } from "@frameos-cloud/ledger";
import type { PlanLimits } from "./usage";

export type PlanFeature =
  | "share_frames"
  | "virtual_frames"
  | "sso"
  | "priority_support"
  | "dedicated_support";

export type PlanGroupKey = "free" | "private" | "business";

export type PlanLimitKey = "cloud_rendered_frames" | "people";

/** On the cards as what the plan will include; not built yet. */
export const plannedFeatures: readonly PlanFeature[] = ["share_frames", "sso"];

/**
 * Limits that count something not built yet (sharing). `cloud_rendered_frames`
 * left this list with virtual frames (docs/cloud-frames.md "Virtual frames")
 * and covers the hardware the cloud renders for too (an ESP32-C3, a board
 * set to render on the server: docs/server-rendering.md).
 */
export const plannedLimits: readonly PlanLimitKey[] = ["people"];

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
  // Bought at checkout, without writing to support first.
  selfServe: boolean;
  // The slider's stops, cheapest first.
  stops: PlanStopDefinition[];
}

export const planGroups: PlanGroupDefinition[] = [
  { features: [], key: "free", name: "Free", selfServe: false, stops: [{ usd: 0 }] },
  {
    features: ["share_frames", "virtual_frames"],
    key: "private",
    name: "Private",
    selfServe: true,
    stops: [
      { frames: 40, usd: 2 },
      { frames: 60, usd: 5 },
      { frames: 80, usd: 9 },
      { frames: 160, usd: 29 },
    ],
  },
  {
    features: ["share_frames", "virtual_frames", "sso", "priority_support"],
    featuresFrom: [{ feature: "dedicated_support", usd: 499 }],
    key: "business",
    name: "Business",
    // At checkout like Private; single sign-on shows as planned until it ships.
    selfServe: true,
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

export interface SelfServeStop {
  code: string;
  group: PlanGroupKey;
  groupName: string;
  stop: PlanStopDefinition;
}

/** Every stop that is bought at checkout, cheapest first. */
export function selfServeStops(): SelfServeStop[] {
  return planGroups
    .filter((group) => group.selfServe)
    .flatMap((group) =>
      group.stops.map((stop) => ({
        code: catalogPlanCode(group.key, stop.usd),
        group: group.key,
        groupName: group.name,
        stop,
      })),
    );
}

/**
 * The billing_plans row a paid stop is activated with: the stop's limits as
 * entitlements, without the ones that are still planned.
 */
export function planRowFor(free: PlanLimits, entry: SelfServeStop, marginBasisPoints: number) {
  const limits = catalogLimits(free, entry.stop);
  return {
    code: entry.code,
    currency: "USD",
    description: `${entry.groupName} at ${entry.stop.usd} dollars a month.`,
    entitlements: {
      backup_bytes: limits.backupBytes,
      cloud_rendered_frames: plannedLimits.includes("cloud_rendered_frames")
        ? free.cloudRenderedFrames
        : limits.cloudRenderedFrames,
      frame_log_bytes: limits.frameLogBytes,
      frames: limits.frames,
      photo_bytes: limits.photoBytes,
      private_scene_bytes: limits.privateSceneBytes,
    },
    marginBasisPoints,
    name: entry.groupName,
    period: "month",
    priceMicros: BigInt(entry.stop.usd) * 1_000_000n,
    public: true,
    sortOrder: entry.stop.usd,
  };
}

/**
 * The catalog in the wire shape (snake_case, string prices: it crosses the
 * AGPL boundary like every account payload). `free` is what the free plan
 * comes to on this deployment, `currentPlanCode` the account's plan, and
 * `purchasable` the plan codes this visitor can take at checkout right now
 * (none when the payment provider is not set up).
 */
export function planCatalog(
  free: PlanLimits,
  currentPlanCode: string,
  purchasable: ReadonlySet<string> = new Set(),
) {
  return {
    groups: planGroups.map((group) => ({
      // False: "contact support to activate".
      available:
        group.key === "free" ||
        (group.selfServe &&
          group.stops.some((stop) => purchasable.has(catalogPlanCode(group.key, stop.usd)))),
      key: group.key,
      name: group.name,
      stops: group.stops.map((stop) => {
        const { usd } = stop;
        const code = catalogPlanCode(group.key, usd);
        const limits = catalogLimits(free, stop);
        const features = [
          ...group.features,
          ...(group.featuresFrom ?? []).filter((extra) => usd >= extra.usd).map((extra) => extra.feature),
        ];
        return {
          code,
          current: code === currentPlanCode,
          features,
          limits: {
            backup_bytes: limits.backupBytes,
            cloud_rendered_frames: limits.cloudRenderedFrames,
            frame_log_bytes: limits.frameLogBytes,
            frames: limits.frames,
            people: limits.people,
            photo_bytes: limits.photoBytes,
            private_scene_bytes: limits.privateSceneBytes,
          },
          // The features above that are not built yet.
          planned_features: features.filter((feature) => plannedFeatures.includes(feature)),
          price_micros: (BigInt(usd) * 1_000_000n).toString(),
          // This visitor can take it at checkout.
          purchasable: group.selfServe && purchasable.has(code),
        };
      }),
    })),
    // Limit rows that count something not built yet.
    planned_limits: [...plannedLimits],
  };
}

export type PlanCatalog = ReturnType<typeof planCatalog>;

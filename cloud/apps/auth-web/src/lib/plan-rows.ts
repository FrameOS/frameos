import { billingPlans, type createDb } from "@frameos-cloud/db";
import { fallbackPaygPlan, listPlans, paygPlanCode } from "@frameos-cloud/ledger";
import { planRowFor, selfServeStops, type SelfServeStop } from "./plan-catalog";
import { limitsForPlan } from "./usage";

export interface SyncedPlanRow {
  code: string;
  entry: SelfServeStop;
  priceMicros: bigint;
}

// "Sync plans": give every self-serve stop of the catalog its billing_plans
// row, with the stop's limits as entitlements and the free plan's margin (AI
// costs the same on every plan). Safe to run again: an existing row takes
// the catalog's current numbers. With Stripe set up, the same step makes
// each stop's price there (billing-provider.ts syncPlans); without it, the
// rows are what the operator plan route moves accounts onto.
export async function syncPlanRows(db: ReturnType<typeof createDb>): Promise<SyncedPlanRow[]> {
  const plans = await listPlans(db);
  const freePlan = plans.find((plan) => plan.code === paygPlanCode) ?? fallbackPaygPlan;
  const free = limitsForPlan(freePlan);
  const rows: SyncedPlanRow[] = [];
  for (const entry of selfServeStops()) {
    const row = planRowFor(free, entry, freePlan.marginBasisPoints);
    await db
      .insert(billingPlans)
      .values(row)
      .onConflictDoUpdate({
        set: {
          description: row.description,
          entitlements: row.entitlements,
          name: row.name,
          public: row.public,
          sortOrder: row.sortOrder,
          updatedAt: new Date(),
        },
        target: billingPlans.code,
      });
    rows.push({ code: entry.code, entry, priceMicros: row.priceMicros });
  }
  return rows;
}

import { billingPlans, type createDb } from "@frameos-cloud/db";
import { fallbackPaygPlan, listPlans, paygPlanCode } from "@frameos-cloud/ledger";
import { planRowFor, selfServeStops } from "./plan-catalog";
import { limitsForPlan } from "./usage";

// "Sync plans": give every self-serve stop of the catalog its billing_plans
// row, with the stop's limits as entitlements and the free plan's margin (AI
// costs the same on every plan). Safe to run again: an existing row takes
// the catalog's current numbers. A payment provider adapter adds its
// products to the same step; without one, the rows are what the operator
// plan route moves accounts onto.
export async function syncPlanRows(db: ReturnType<typeof createDb>): Promise<string[]> {
  const plans = await listPlans(db);
  const freePlan = plans.find((plan) => plan.code === paygPlanCode) ?? fallbackPaygPlan;
  const free = limitsForPlan(freePlan);
  const codes: string[] = [];
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
    codes.push(entry.code);
  }
  return codes;
}

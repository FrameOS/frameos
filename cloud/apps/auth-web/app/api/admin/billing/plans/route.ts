import { NextRequest, NextResponse } from "next/server";
import { getSuperadminContext, superadminRefusal } from "../../../../../src/lib/admin";
import { recordAuditEvent } from "../../../../../src/lib/audit";
import { syncPlans } from "../../../../../src/lib/billing-provider";
import { csrfResponse } from "../../../../../src/lib/csrf";
import { jsonError, requireDatabase } from "../../../../../src/lib/device-flow";
import { getAccountBaseUrl, getAccountSettingsUrl, getCloudBaseUrl } from "../../../../../src/lib/env";
import { reportError } from "../../../../../src/lib/log";
import { syncPlanRows } from "../../../../../src/lib/plan-rows";
import { rateLimitResponse } from "../../../../../src/lib/rate-limit";
import { StripeApiError, stripeSetup } from "../../../../../src/lib/stripe";

export const runtime = "nodejs";

// "Sync plans" on /admin/billing/customers and /admin/billing/payments.
// Always: write the catalog's self-serve stops as billing_plans rows
// (src/lib/plan-rows.ts). With Stripe set up, also: each stop's price at
// Stripe in the deployment's mode, the customer portal's settings, and a
// read of the tax settings and the webhook endpoint. It is what makes a
// plan buyable, and it is safe to press again.
export async function POST(request: NextRequest) {
  const csrf = csrfResponse(request);
  if (csrf) {
    return csrf;
  }
  const limited = await rateLimitResponse(request, "admin:billing-plans-sync", {
    limit: 20,
    windowMs: 15 * 60 * 1000,
  });
  if (limited) {
    return limited;
  }
  const admin = await getSuperadminContext({ mutation: true });
  if (admin.kind !== "ok") {
    return superadminRefusal(admin);
  }
  const { db, response } = requireDatabase();
  if (!db) {
    return response;
  }
  const setup = stripeSetup();
  if (!setup.config) {
    const rows = await syncPlanRows(db);
    await recordAuditEvent(db, {
      accountId: admin.accountId,
      actor: { accountId: admin.accountId, kind: "superadmin" },
      eventType: "admin.billing_plans_synced",
      metadata: { plans: rows.map((row) => row.code) },
    });
    return NextResponse.json(
      {
        plans: rows.map((row) => ({ code: row.code, created: false, price_id: null })),
        provider: null,
        // Why nothing was made at Stripe, when it is set up wrong.
        ...(setup.problem ? { provider_problem: setup.problem } : {}),
      },
      { headers: { "cache-control": "no-store" } },
    );
  }
  try {
    const cloud = getCloudBaseUrl();
    const result = await syncPlans(db, setup.config, {
      headline: "FrameOS Cloud: your plan, your invoices and your card.",
      privacyPolicyUrl: new URL("/legal/privacy", cloud).toString(),
      returnUrl: getAccountSettingsUrl("usage"),
      termsOfServiceUrl: new URL("/legal/terms", cloud).toString(),
      webhookUrl: new URL("/api/webhooks/stripe", getAccountBaseUrl()).toString(),
    });
    await recordAuditEvent(db, {
      accountId: admin.accountId,
      actor: { accountId: admin.accountId, kind: "superadmin" },
      eventType: "admin.billing_plans_synced",
      metadata: {
        created: result.plans.filter((plan) => plan.created).map((plan) => plan.code),
        mode: setup.config.mode,
        plans: result.plans.map((plan) => plan.code),
      },
    });
    return NextResponse.json(
      {
        checks: {
          tax_status: result.checks.taxStatus,
          webhook: {
            api_version: result.checks.webhook.apiVersion,
            enabled: result.checks.webhook.enabled,
            found: result.checks.webhook.found,
            missing_events: result.checks.webhook.missingEvents,
          },
        },
        mode: setup.config.mode,
        plans: result.plans.map((plan) => ({
          code: plan.code,
          created: plan.created,
          price_id: plan.priceId,
        })),
        portal_configuration: result.portal.id,
        provider: "stripe",
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof StripeApiError) {
      reportError("billing.plan_sync_failed", error, { mode: setup.config.mode });
      return jsonError("payment_provider_failed", 502, { detail: error.message });
    }
    throw error;
  }
}

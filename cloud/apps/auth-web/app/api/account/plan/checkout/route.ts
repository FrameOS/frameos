import { and, eq } from "drizzle-orm";
import { accountIdentities, accounts } from "@frameos-cloud/db";
import { listPlans } from "@frameos-cloud/ledger";
import { NextRequest, NextResponse } from "next/server";
import { recordAuditEvent } from "../../../../../src/lib/audit";
import {
  BillingError,
  checkoutOpenTo,
  startCheckout,
} from "../../../../../src/lib/billing-provider";
import { csrfResponse } from "../../../../../src/lib/csrf";
import {
  jsonError,
  readJsonObject,
  requireDatabase,
} from "../../../../../src/lib/device-flow";
import { getAccountBaseUrl, getAccountSettingsUrl } from "../../../../../src/lib/env";
import { reportError } from "../../../../../src/lib/log";
import { rateLimitResponse } from "../../../../../src/lib/rate-limit";
import { readSession } from "../../../../../src/lib/session";
import { StripeApiError, stripeSetup } from "../../../../../src/lib/stripe";
import { accountIsSuperadmin } from "../../../../../src/lib/superadmin";

export const runtime = "nodejs";

// Start buying a paid plan: open a Stripe Checkout session and hand back its
// URL. Nothing changes on the account here. The plan arrives when Stripe
// says the payment did (the return route and the webhook).
export async function POST(request: NextRequest) {
  const csrf = csrfResponse(request);
  if (csrf) {
    return csrf;
  }
  const limited = await rateLimitResponse(request, "account:plan-checkout", {
    limit: 20,
    windowMs: 60 * 60 * 1000,
  });
  if (limited) {
    return limited;
  }
  const session = await readSession();
  if (!session?.accountId) {
    return jsonError("login_required", 401);
  }
  // A person in a browser, never a script's bearer (see the plan route).
  if (session.apiToken) {
    return jsonError("api_token_not_allowed", 403);
  }
  const { db, response } = requireDatabase();
  if (!db) {
    return response;
  }
  const setup = stripeSetup();
  const accountId = session.accountId;
  if (
    !setup.config ||
    !checkoutOpenTo(setup.config.mode, await accountIsSuperadmin(accountId))
  ) {
    return jsonError("plans_not_available", 503, {
      detail: "Paid plans cannot be bought here yet. Contact support to activate one.",
    });
  }

  const body = await readJsonObject(request);
  const code = typeof body.plan === "string" ? body.plan.trim() : "";
  const target = (await listPlans(db)).find((plan) => plan.code === code);
  if (!target || !target.public || target.priceMicros === 0n) {
    return jsonError("unknown_plan", 404);
  }
  const [account] = await db
    .select({ primaryEmail: accounts.primaryEmail })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  if (!account?.primaryEmail) {
    return jsonError("email_required", 400, {
      detail: "Add an email address to your account first. The receipt goes there.",
    });
  }
  const [verified] = await db
    .select({ id: accountIdentities.id })
    .from(accountIdentities)
    .where(and(eq(accountIdentities.accountId, accountId), eq(accountIdentities.emailVerified, true)))
    .limit(1);
  if (!verified) {
    return jsonError("email_not_verified", 403, {
      detail: "Verify your email address first. The receipt goes there.",
    });
  }

  try {
    const checkout = await startCheckout(db, setup.config, {
      accountId,
      email: account.primaryEmail,
      planCode: target.code,
      // Absolute and from configuration: behind the proxy the request's own
      // URL is localhost.
      returnUrl: new URL("/api/account/plan/checkout/return", getAccountBaseUrl()).toString(),
      cancelUrl: (() => {
        const url = new URL(getAccountSettingsUrl("usage"));
        url.searchParams.set("checkout", "canceled");
        return url.toString();
      })(),
    });
    await recordAuditEvent(db, {
      accountId,
      actor: { accountId, kind: "account" },
      eventType: "account.plan_checkout_started",
      metadata: { mode: setup.config.mode, plan: target.code },
      target: { accountId, kind: "account" },
    });
    return NextResponse.json(
      { checkout_url: checkout.url, mode: setup.config.mode },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof BillingError) {
      return jsonError(error.code, error.status, { detail: error.message });
    }
    if (error instanceof StripeApiError) {
      reportError("billing.checkout_failed", error, { accountId, plan: target.code });
      return jsonError("payment_provider_failed", 502, {
        detail: "Checkout could not be started. Nothing was charged. Try again in a moment.",
      });
    }
    throw error;
  }
}

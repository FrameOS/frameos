import { NextRequest, NextResponse } from "next/server";
import { BillingError, handleCheckoutReturn } from "../../../../../../src/lib/billing-provider";
import { requireDatabase } from "../../../../../../src/lib/device-flow";
import { getAccountSettingsUrl } from "../../../../../../src/lib/env";
import { reportError } from "../../../../../../src/lib/log";
import { rateLimitResponse } from "../../../../../../src/lib/rate-limit";
import { readSession } from "../../../../../../src/lib/session";
import { stripeSetup } from "../../../../../../src/lib/stripe";

export const runtime = "nodejs";

// Where Stripe sends the browser after checkout. It always
// ends on the usage page, which says how it went:
//   ?checkout=active   the plan is on the account
//   ?checkout=pending  paid, and Stripe has not confirmed it yet
//   ?checkout=failed   the link was not a checkout's, was another account's,
//                      or the checkout expired
// Granting the plan here, and not only in the webhook, is what makes the
// page right the moment the person lands on it.
function usagePage(outcome: "active" | "failed" | "pending") {
  const url = new URL(getAccountSettingsUrl("usage"));
  url.searchParams.set("checkout", outcome);
  return NextResponse.redirect(url, {
    headers: { "cache-control": "no-store" },
    status: 303,
  });
}

export async function GET(request: NextRequest) {
  const limited = await rateLimitResponse(request, "account:plan-checkout-return", {
    limit: 60,
    windowMs: 15 * 60 * 1000,
  });
  if (limited) {
    return limited;
  }
  const session = await readSession();
  const setup = stripeSetup();
  const { db } = requireDatabase();
  if (!session?.accountId || session.apiToken || !setup.config || !db) {
    // Signed out in the meantime: the usage page asks them to sign in, and
    // the webhook grants the plan without this request.
    return usagePage("pending");
  }
  try {
    return usagePage(
      await handleCheckoutReturn(
        db,
        setup.config,
        request.nextUrl.searchParams.get("session_id") ?? "",
        session.accountId,
      ),
    );
  } catch (error) {
    if (error instanceof BillingError && (error.code === "invalid_session" || error.code === "wrong_account")) {
      return usagePage("failed");
    }
    // Stripe could not be read back just now. The payment is not in
    // doubt; the webhook finishes the job.
    reportError("billing.checkout_return_failed", error, { accountId: session.accountId });
    return usagePage("pending");
  }
}

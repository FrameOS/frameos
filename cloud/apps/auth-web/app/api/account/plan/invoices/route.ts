import { NextRequest, NextResponse } from "next/server";
import { accountInvoices } from "../../../../../src/lib/billing-provider";
import { jsonError, requireDatabase } from "../../../../../src/lib/device-flow";
import { reportError } from "../../../../../src/lib/log";
import { rateLimitResponse } from "../../../../../src/lib/rate-limit";
import { readSession } from "../../../../../src/lib/session";
import { StripeApiError, stripeSetup } from "../../../../../src/lib/stripe";

export const runtime = "nodejs";

// The account's invoices, for the usage page's table: Stripe's list with
// its invoice page and PDF links, and what was refunded on each. The links
// open the customer's own billing records, so, like the portal, they are
// for a signed-in person and not an API token.
export async function GET(request: NextRequest) {
  const limited = await rateLimitResponse(request, "account:plan-invoices", {
    limit: 120,
    windowMs: 15 * 60 * 1000,
  });
  if (limited) {
    return limited;
  }
  const session = await readSession();
  if (!session?.accountId) {
    return jsonError("login_required", 401);
  }
  if (session.apiToken) {
    return jsonError("api_token_not_allowed", 403);
  }
  const { db, response } = requireDatabase();
  if (!db) {
    return response;
  }
  const setup = stripeSetup();
  if (!setup.config) {
    return NextResponse.json({ invoices: [] }, { headers: { "cache-control": "no-store" } });
  }
  try {
    const invoices = await accountInvoices(db, setup.config, session.accountId);
    return NextResponse.json({ invoices }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof StripeApiError) {
      reportError("billing.invoices_failed", error, { accountId: session.accountId });
      return jsonError("payment_provider_failed", 502, {
        detail: "The invoices could not be loaded. Try again in a moment.",
      });
    }
    throw error;
  }
}

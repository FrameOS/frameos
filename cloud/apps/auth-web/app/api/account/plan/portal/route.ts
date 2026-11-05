import { NextRequest, NextResponse } from "next/server";
import { BillingError, portalLink } from "../../../../../src/lib/billing-provider";
import { CreemError, creemSetup } from "../../../../../src/lib/creem";
import { csrfResponse } from "../../../../../src/lib/csrf";
import { jsonError, requireDatabase } from "../../../../../src/lib/device-flow";
import { reportError } from "../../../../../src/lib/log";
import { rateLimitResponse } from "../../../../../src/lib/rate-limit";
import { readSession } from "../../../../../src/lib/session";

export const runtime = "nodejs";

// A link to the payment provider's customer portal: invoices, the card on
// file, and cancelling. The link is the customer's key to their billing
// account, so it is made per click and never stored.
export async function POST(request: NextRequest) {
  const csrf = csrfResponse(request);
  if (csrf) {
    return csrf;
  }
  const limited = await rateLimitResponse(request, "account:plan-portal", {
    limit: 30,
    windowMs: 60 * 60 * 1000,
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
  const setup = creemSetup();
  if (!setup.config) {
    return jsonError("plans_not_available", 503);
  }
  try {
    const url = await portalLink(db, setup.config, session.accountId);
    return NextResponse.json({ url }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof BillingError) {
      return jsonError(error.code, error.status, { detail: error.message });
    }
    if (error instanceof CreemError) {
      reportError("billing.portal_failed", error, { accountId: session.accountId });
      return jsonError("payment_provider_failed", 502, {
        detail: "The billing page could not be opened. Try again in a moment.",
      });
    }
    throw error;
  }
}

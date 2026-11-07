import { NextRequest, NextResponse } from "next/server";
import { handleWebhook } from "../../../../src/lib/billing-provider";
import { jsonError, readBoundedBytes, requireDatabase } from "../../../../src/lib/device-flow";
import { reportError } from "../../../../src/lib/log";
import { rateLimitResponse } from "../../../../src/lib/rate-limit";
import { stripeSetup } from "../../../../src/lib/stripe";

export const runtime = "nodejs";

// Stripe's webhook (cloud/docs/billing.md). No session and no Origin check:
// the caller is Stripe's server, and what proves it is the Stripe-Signature
// header, an HMAC of the timestamp and the raw body under the endpoint's
// signing secret. The body is therefore read as bytes and never
// re-serialized before the check. Register the endpoint with the events in
// stripe.ts `webhookEvents`; /admin/billing/payments says what is missing.
const maxBodyBytes = 1024 * 1024;

export async function POST(request: NextRequest) {
  const limited = await rateLimitResponse(request, "webhooks:stripe", {
    limit: 600,
    windowMs: 60 * 1000,
  });
  if (limited) {
    return limited;
  }
  const setup = stripeSetup();
  if (!setup.config) {
    // Not configured: say so, so Stripe's dashboard shows a failing
    // endpoint instead of deliveries that vanish.
    return jsonError("not_configured", 503);
  }
  const { db, response } = requireDatabase();
  if (!db) {
    return response;
  }
  const body = await readBoundedBytes(request, maxBodyBytes);
  if (!body) {
    return jsonError("invalid_request", 400);
  }
  if (body.overflow) {
    return jsonError("payload_too_large", 413);
  }
  const result = await handleWebhook(
    db,
    setup.config,
    body.bytes.toString("utf8"),
    request.headers.get("stripe-signature"),
  );
  if (result.alert) {
    // A dispute was opened: someone has days, not weeks, to answer it.
    reportError("billing.dispute_opened", new Error(result.alert), { mode: setup.config.mode });
  }
  if (result.status >= 500) {
    reportError("billing.webhook_failed", new Error(String(result.body["error"] ?? "failed")), {
      mode: setup.config.mode,
    });
  }
  return NextResponse.json(result.body, {
    headers: { "cache-control": "no-store" },
    status: result.status,
  });
}

import { NextRequest, NextResponse } from "next/server";
import { handleWebhook } from "../../../../src/lib/billing-provider";
import { creemSetup } from "../../../../src/lib/creem";
import { jsonError, readBoundedBytes, requireDatabase } from "../../../../src/lib/device-flow";
import { reportError } from "../../../../src/lib/log";
import { rateLimitResponse } from "../../../../src/lib/rate-limit";

export const runtime = "nodejs";

// The payment provider's webhook (cloud/docs/billing.md). No session and no
// Origin check: the caller is the provider's server, and what proves it is
// the HMAC of the raw body under the webhook secret. The body is therefore
// read as bytes and never re-serialized before the check.
const maxBodyBytes = 1024 * 1024;

export async function POST(request: NextRequest) {
  const limited = await rateLimitResponse(request, "webhooks:creem", {
    limit: 600,
    windowMs: 60 * 1000,
  });
  if (limited) {
    return limited;
  }
  const setup = creemSetup();
  if (!setup.config) {
    // Not configured: say so, so the provider's dashboard shows a failing
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
    request.headers.get("creem-signature"),
  );
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

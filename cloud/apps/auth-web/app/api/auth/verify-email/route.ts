import { createDb } from "@frameos-cloud/db";
import { NextRequest, NextResponse } from "next/server";
import { csrfResponse } from "../../../../src/lib/csrf";
import { confirmEmailVerification } from "../../../../src/lib/email-verification";
import { assertDatabaseUrlConfigured, hasDatabaseUrl } from "../../../../src/lib/env";
import { rateLimitResponse } from "../../../../src/lib/rate-limit";

// Consumes an email-verification token. A POST behind a button, never the
// page render: mail providers and chat clients fetch links to preview them,
// and a GET that verified on sight let a link scanner at the victim's mail
// provider verify an account an attacker had created under the victim's
// address — which then quietly became the account the victim's later Google
// sign-in linked into.
export async function POST(request: NextRequest) {
  const csrf = csrfResponse(request);
  if (csrf) {
    return csrf;
  }
  const limited = await rateLimitResponse(request, "auth:verify-email", {
    limit: 20,
    windowMs: 15 * 60 * 1000,
  });
  if (limited) {
    return limited;
  }

  const body = (await request.json().catch(() => undefined)) as
    | { token?: unknown }
    | undefined;
  const token = typeof body?.token === "string" ? body.token.trim() : "";
  if (!token || token.length > 512 || !hasDatabaseUrl()) {
    return NextResponse.json({ error: "invalid_token" }, { status: 400 });
  }

  assertDatabaseUrlConfigured();
  const result = await confirmEmailVerification(createDb(), token);
  if (result !== "verified") {
    return NextResponse.json({ error: "invalid_token" }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}

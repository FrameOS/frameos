// Re-authentication with the password or an authenticator / recovery code.
// Body: {"password": "..."} or {"code": "..."}, plus an optional return_to.
// A stale session sent here by a 403 reauth_required proves itself and goes
// back; the session token never changes, only its authenticated_at.
import { eq } from "drizzle-orm";
import { accounts, createDb } from "@frameos-cloud/db";
import { NextRequest, NextResponse } from "next/server";
import { assertDatabaseUrlConfigured } from "../../../../src/lib/env";
import { verifyPasswordWithDummyFallback } from "../../../../src/lib/passwords";
import {
  reauthContext,
  reauthenticatedResponse,
  recordReauthFailed,
} from "../../../../src/lib/reauth";
import {
  secondFactorStatus,
  verifySecondFactorCode,
} from "../../../../src/lib/two-factor";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const context = await reauthContext(request);
  if ("response" in context) {
    return context.response;
  }
  const body = (await request.json().catch(() => undefined)) as
    | { code?: unknown; password?: unknown; return_to?: unknown }
    | undefined;

  assertDatabaseUrlConfigured();
  const db = createDb();

  if (typeof body?.password === "string" && body.password) {
    const [account] = await db
      .select({ passwordHash: accounts.passwordHash })
      .from(accounts)
      .where(eq(accounts.id, context.accountId))
      .limit(1);
    // The dummy hash keeps the timing flat for accounts without a password;
    // they can never succeed here and must use a code or passkey instead.
    const valid = await verifyPasswordWithDummyFallback(
      body.password,
      account?.passwordHash,
    );
    if (!valid) {
      await recordReauthFailed(db, context, "password");
      return NextResponse.json({ error: "invalid_password" }, { status: 403 });
    }
    return reauthenticatedResponse(db, context, "password", body.return_to);
  }

  const code = typeof body?.code === "string" ? body.code.trim() : "";
  if (!code) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const matched = await verifySecondFactorCode(db, context.accountId, code);
  if (!matched) {
    await recordReauthFailed(db, context, "code");
    return NextResponse.json({ error: "invalid_code" }, { status: 403 });
  }
  const extra: Record<string, unknown> = {};
  if (matched === "recovery_code") {
    const status = await secondFactorStatus(db, context.accountId);
    extra.recovery_codes_remaining = status.recoveryCodesRemaining;
  }
  return reauthenticatedResponse(db, context, matched, body?.return_to, extra);
}

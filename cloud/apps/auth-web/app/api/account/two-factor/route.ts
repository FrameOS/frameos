// Second-factor status for the signed-in account (the Security page).
import { NextRequest, NextResponse } from "next/server";
import {
  accountSecurityContext,
  twoFactorStatusPayload,
} from "../../../../src/lib/account-security";
import { requireDatabase } from "../../../../src/lib/device-flow";

export async function GET(request: NextRequest) {
  const { db, response } = requireDatabase();
  if (!db) {
    return response;
  }
  const context = await accountSecurityContext(request, db, {
    action: "two-factor-status",
    limit: 120,
  });
  if ("response" in context) {
    return context.response;
  }
  return NextResponse.json(await twoFactorStatusPayload(db, context.accountId, context.hasPassword));
}

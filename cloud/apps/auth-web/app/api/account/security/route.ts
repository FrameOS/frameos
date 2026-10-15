import { eq } from "drizzle-orm";
import { accounts } from "@frameos-cloud/db";
import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireDatabase } from "../../../../src/lib/device-flow";
import { rateLimitResponse } from "../../../../src/lib/rate-limit";
import { readSession } from "../../../../src/lib/session";

export const runtime = "nodejs";

// What the Security page of the frames workspace
// (frontend/src/scenes/settings/account/SecurityPage.tsx) needs to know
// before it draws a form: whether the account has a password (the change
// and delete forms confirm with it; a Google-only account types its email),
// whether it is a superadmin (which may not delete itself), and the email
// to confirm with. The second factor's status is GET /api/account/two-factor.
export async function GET(request: NextRequest) {
  const limited = await rateLimitResponse(request, "account:security", {
    limit: 240,
    windowMs: 15 * 60 * 1000,
  });
  if (limited) {
    return limited;
  }
  const session = await readSession();
  if (!session?.accountId) {
    return jsonError("login_required", 401);
  }
  const { db, response } = requireDatabase();
  if (!db) {
    return response;
  }
  const [account] = await db
    .select({
      displayName: accounts.displayName,
      isSuperadmin: accounts.isSuperadmin,
      passwordHash: accounts.passwordHash,
      primaryEmail: accounts.primaryEmail,
    })
    .from(accounts)
    .where(eq(accounts.id, session.accountId))
    .limit(1);
  if (!account) {
    return jsonError("login_required", 401);
  }
  return NextResponse.json(
    {
      email: account.primaryEmail ?? null,
      has_password: Boolean(account.passwordHash),
      is_superadmin: Boolean(account.isSuperadmin),
      name: account.displayName ?? null,
    },
    { headers: { "cache-control": "no-store" } },
  );
}

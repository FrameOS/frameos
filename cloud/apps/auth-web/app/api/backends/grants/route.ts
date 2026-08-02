import { eq } from "drizzle-orm";
import { accounts } from "@frameos-cloud/db";
import { NextRequest, NextResponse } from "next/server";
import { authenticateLinkedClient } from "../../../../src/lib/backend-auth";
import { jsonError, requireDatabase } from "../../../../src/lib/device-flow";
import { rateLimitResponse } from "../../../../src/lib/rate-limit";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const limited = rateLimitResponse(request, "backend:grants", {
    limit: 120,
    windowMs: 15 * 60 * 1000,
  });
  if (limited) {
    return limited;
  }

  const { db, response } = requireDatabase();
  if (!db) {
    return response;
  }

  const linkedClient = await authenticateLinkedClient(
    db,
    request.headers.get("authorization"),
  );
  if (!linkedClient) {
    return jsonError("invalid_link_token", 401);
  }

  // Display/contact snapshot only, so the backend can show "Connected as
  // <email>"; account identity stays keyed on the provider identity, never on
  // this email (see the accounts schema note).
  const [account] = await db
    .select({ primaryEmail: accounts.primaryEmail })
    .from(accounts)
    .where(eq(accounts.id, linkedClient.accountId))
    .limit(1);

  return NextResponse.json({
    grants: [
      {
        account_email: account?.primaryEmail ?? null,
        account_id: linkedClient.accountId,
        role: "owner",
        updated_at: linkedClient.updatedAt.toISOString(),
      },
    ],
    linked_client_id: linkedClient.id,
  });
}

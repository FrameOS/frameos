import { and, eq, isNull } from "drizzle-orm";
import { accountApiTokens } from "@frameos-cloud/db";
import { NextRequest, NextResponse } from "next/server";
import { recordAuditEvent } from "../../../../../src/lib/audit";
import { csrfResponse } from "../../../../../src/lib/csrf";
import {
  jsonError,
  requireDatabase,
} from "../../../../../src/lib/device-flow";
import { rateLimitResponse } from "../../../../../src/lib/rate-limit";
import { readSession } from "../../../../../src/lib/session";

export const runtime = "nodejs";

// Revoke one personal API token. Revocation is the safe direction, so any
// live session may do it — a token may even revoke itself, which is how an
// agent that suspects a leak cuts its own access.
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ tokenId: string }> },
) {
  const csrf = csrfResponse(request);
  if (csrf) {
    return csrf;
  }
  const limited = await rateLimitResponse(
    request,
    "account:api-tokens-revoke",
    { limit: 60, windowMs: 15 * 60 * 1000 },
  );
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
  const { tokenId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(tokenId)) {
    return jsonError("token_not_found", 404);
  }
  const rows = await db
    .update(accountApiTokens)
    .set({ revokedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(accountApiTokens.id, tokenId),
        eq(accountApiTokens.accountId, session.accountId),
        isNull(accountApiTokens.revokedAt),
      ),
    )
    .returning({ id: accountApiTokens.id, name: accountApiTokens.name });
  const revoked = rows[0];
  if (!revoked) {
    return jsonError("token_not_found", 404);
  }
  await recordAuditEvent(db, {
    accountId: session.accountId,
    actor: {
      accountId: session.accountId,
      providerSubject: session.providerSubject,
    },
    eventType: "account.api_token_revoked",
    metadata: { name: revoked.name },
    target: { apiTokenId: revoked.id },
  });
  return NextResponse.json({ status: "revoked" });
}

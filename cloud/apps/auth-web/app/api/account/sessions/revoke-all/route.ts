import { and, eq, isNull, ne } from "drizzle-orm";
import { createDb, sessions } from "@frameos-cloud/db";
import { NextRequest, NextResponse } from "next/server";
import { recordAuditEvent } from "../../../../../src/lib/audit";
import { csrfResponse } from "../../../../../src/lib/csrf";
import { assertDatabaseUrlConfigured } from "../../../../../src/lib/env";
import { rateLimitResponse } from "../../../../../src/lib/rate-limit";
import { requireRecentAuth } from "../../../../../src/lib/recent-auth";
import { hashSecret } from "../../../../../src/lib/secrets";
import { readSession, readSessionToken } from "../../../../../src/lib/session";

// Self-serve "sign out everywhere": revokes every session on the account
// except the one pressing the button. Until now the only revoke-all lived
// behind /api/admin — a user who left a laptop open somewhere had to change
// their password to evict it. Behind sudo mode like the other revoke
// actions (docs/auth.md "Re-authentication"): a stolen cookie must not be
// able to lock the real owner out of their other devices.
//
// Personal API tokens are deliberately NOT revoked here: they are a separate
// credential the developer page manages one by one, and this button is
// about browsers, not scripts. The admin route and a password reset evict
// both, because there the account itself is presumed compromised.
export async function POST(request: NextRequest) {
  const csrf = csrfResponse(request);
  if (csrf) {
    return csrf;
  }
  const limited = await rateLimitResponse(request, "account:sessions", {
    limit: 10,
    windowMs: 15 * 60 * 1000,
  });
  if (limited) {
    return limited;
  }

  const session = await readSession();
  const token = await readSessionToken();
  if (!session?.accountId || !token) {
    return NextResponse.json({ error: "login_required" }, { status: 401 });
  }

  assertDatabaseUrlConfigured();
  const db = createDb();
  const reauth = await requireRecentAuth(db, session.accountId);
  if (reauth) {
    return reauth;
  }

  const revoked = await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(sessions.accountId, session.accountId),
        isNull(sessions.revokedAt),
        ne(sessions.tokenHash, hashSecret(token)),
      ),
    )
    .returning({ id: sessions.id });

  await recordAuditEvent(db, {
    accountId: session.accountId,
    actor: {
      accountId: session.accountId,
      providerSubject: session.providerSubject,
    },
    eventType: "account.sessions_revoked",
    metadata: { sessions: revoked.length },
  });

  return NextResponse.json({ ok: true, revoked: revoked.length });
}

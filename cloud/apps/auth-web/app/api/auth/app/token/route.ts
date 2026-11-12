import { and, eq } from "drizzle-orm";
import { accountIdentities, accounts } from "@frameos-cloud/db";
import { NextRequest, NextResponse } from "next/server";
import {
  appSignInCodeClaimKey,
  appSignInCodeMaxAgeSeconds,
  pkceMatches,
  verifyAppSignInCode,
} from "../../../../../src/lib/app-sign-in";
import { recordAuditEvent } from "../../../../../src/lib/audit";
import { csrfResponse } from "../../../../../src/lib/csrf";
import {
  jsonError,
  readJsonObject,
  requireDatabase,
} from "../../../../../src/lib/device-flow";
import { claimSingleUse, rateLimitResponse } from "../../../../../src/lib/rate-limit";
import {
  createSession,
  sessionCookieName,
  sessionCookieOptions,
} from "../../../../../src/lib/session";

export const runtime = "nodejs";

// POST /api/auth/app/token {code, code_verifier}: the app's half of the
// sign-in handoff (src/lib/app-sign-in.ts). The code is spent once, only with
// the verifier whose S256 the app sent to /authorize, and the answer is a
// session cookie of the app's own, as /api/auth/login sets one.
export async function POST(request: NextRequest) {
  const csrf = csrfResponse(request);
  if (csrf) {
    return csrf;
  }
  const limited = await rateLimitResponse(request, "app-sign-in:token", {
    limit: 60,
    windowMs: 15 * 60 * 1000,
  });
  if (limited) {
    return limited;
  }

  const body = await readJsonObject(request);
  const code =
    typeof body.code === "string" ? await verifyAppSignInCode(body.code.trim()) : undefined;
  // One answer for every way a code is no good, so a probe learns nothing.
  if (!code || !pkceMatches(body.code_verifier, code.challenge)) {
    return jsonError("invalid_grant", 400);
  }
  const { db, response } = requireDatabase();
  if (!db) {
    return response;
  }
  if (!(await claimSingleUse(appSignInCodeClaimKey(code.codeId), appSignInCodeMaxAgeSeconds * 2000))) {
    return jsonError("invalid_grant", 400);
  }

  // The profile is read now, not carried in the code: the identity may have
  // been unlinked (or the account deleted) since the browser signed in.
  const [resolved] = await db
    .select({
      displayName: accounts.displayName,
      emailSnapshot: accountIdentities.emailSnapshot,
      emailVerified: accountIdentities.emailVerified,
      primaryEmail: accounts.primaryEmail,
      providerIssuer: accountIdentities.providerIssuer,
      providerSubject: accountIdentities.providerSubject,
    })
    .from(accountIdentities)
    .innerJoin(accounts, eq(accounts.id, accountIdentities.accountId))
    .where(
      and(
        eq(accountIdentities.id, code.identityId),
        eq(accountIdentities.accountId, code.accountId),
      ),
    )
    .limit(1);
  if (!resolved) {
    return jsonError("invalid_grant", 400);
  }

  const email = resolved.emailSnapshot ?? resolved.primaryEmail ?? undefined;
  const sessionToken = await createSession(
    db,
    {
      accountId: code.accountId,
      email,
      emailVerified: resolved.emailVerified,
      name: resolved.displayName ?? undefined,
      providerIssuer: resolved.providerIssuer,
      providerSubject: resolved.providerSubject,
    },
    { authenticatedAt: code.authenticatedAt },
  );
  await recordAuditEvent(db, {
    accountId: code.accountId,
    actor: { accountId: code.accountId, providerSubject: resolved.providerSubject },
    eventType: "account.signed_in",
    metadata: { method: "app_handoff" },
    target: { providerIssuer: resolved.providerIssuer },
  });

  const answer = NextResponse.json({ email, ok: true });
  answer.cookies.set(sessionCookieName, sessionToken, sessionCookieOptions());
  return answer;
}

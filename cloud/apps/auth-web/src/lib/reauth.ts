// Shared plumbing for the /api/auth/reauth* proof routes: who is asking, the
// limits on guessing, and what to do once a proof checked out. The check
// itself (requireRecentAuth) lives in recent-auth.ts, next to the session
// row it reads; this file is the write side.

import type { createDb } from "@frameos-cloud/db";
import { NextRequest, NextResponse } from "next/server";
import { safeAuthReturnPath } from "./auth-cookies";
import { recordAuditEvent } from "./audit";
import { csrfResponse } from "./csrf";
import { identityRateLimitResponse, rateLimitResponse } from "./rate-limit";
import { markSessionReauthenticated } from "./recent-auth";
import { readSession, readSessionToken, type SessionProfile } from "./session";

export type ReauthContext = {
  accountId: string;
  session: SessionProfile;
  token: string;
};

// Session + CSRF + the same per-IP and per-account limits the second-factor
// step uses: a six-digit code is guessable at volume, and a stolen cookie
// must not get unlimited tries at the password either.
export async function reauthContext(
  request: NextRequest,
): Promise<ReauthContext | { response: NextResponse }> {
  const csrf = csrfResponse(request);
  if (csrf) {
    return { response: csrf };
  }
  const limited = await rateLimitResponse(request, "auth:reauth", {
    limit: 30,
    windowMs: 15 * 60 * 1000,
  });
  if (limited) {
    return { response: limited };
  }
  const session = await readSession();
  const token = await readSessionToken();
  if (!session?.accountId || !token) {
    return {
      response: NextResponse.json({ error: "login_required" }, { status: 401 }),
    };
  }
  const accountLimited = await identityRateLimitResponse(
    session.accountId,
    "auth:reauth-account",
    { limit: 10, windowMs: 15 * 60 * 1000 },
  );
  if (accountLimited) {
    return { response: accountLimited };
  }
  return { accountId: session.accountId, session, token };
}

export async function recordReauthFailed(
  db: ReturnType<typeof createDb>,
  context: ReauthContext,
  method: string,
) {
  await recordAuditEvent(db, {
    accountId: context.accountId,
    actor: {
      accountId: context.accountId,
      providerSubject: context.session.providerSubject,
    },
    eventType: "account.reauthentication_failed",
    metadata: { method },
  });
}

// Proof accepted: stamp the session, audit it, and tell the form where to go.
export async function reauthenticatedResponse(
  db: ReturnType<typeof createDb>,
  context: ReauthContext,
  method: string,
  returnTo: unknown,
  extra: Record<string, unknown> = {},
) {
  const stamped = await markSessionReauthenticated(db, context.token);
  if (!stamped) {
    return NextResponse.json({ error: "login_required" }, { status: 401 });
  }
  await recordAuditEvent(db, {
    accountId: context.accountId,
    actor: {
      accountId: context.accountId,
      providerSubject: context.session.providerSubject,
    },
    eventType: "account.reauthenticated",
    metadata: { method, ...extra },
  });
  return NextResponse.json({
    ok: true,
    redirect:
      (typeof returnTo === "string" ? safeAuthReturnPath(returnTo) : undefined) ??
      "/account",
    ...extra,
  });
}

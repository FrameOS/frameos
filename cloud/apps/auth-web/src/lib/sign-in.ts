// The last step of every sign-in, shared by the password and Google routes:
// either mint the session right away, or — when the account has a second
// factor — hand back a pending-sign-in token and let /login/verify finish.

import type { createDb } from "@frameos-cloud/db";
import { NextRequest, NextResponse } from "next/server";
import { recordAuditEvent } from "./audit";
import {
  createSession,
  sessionCookieName,
  sessionCookieOptions,
  type SessionProfile,
} from "./session";
import {
  availableSecondFactors,
  createPendingSignInToken,
  pendingSignInCookieName,
  pendingSignInCookieOptions,
  readPendingSignInToken,
  type PendingSignIn,
  type SecondFactorMethod,
} from "./two-factor";

export type FirstFactorOutcome =
  | { kind: "session"; token: string }
  | {
      kind: "second_factor";
      factors: Awaited<ReturnType<typeof availableSecondFactors>>;
      pendingToken: string;
    };

export async function completeFirstFactor(
  db: ReturnType<typeof createDb>,
  input: {
    auditMetadata?: Record<string, unknown> | undefined;
    method: PendingSignIn["method"];
    profile: SessionProfile & { accountId: string };
    returnTo?: string | undefined;
  },
): Promise<FirstFactorOutcome> {
  const factors = await availableSecondFactors(db, input.profile.accountId);
  if (factors.enabled) {
    const pendingToken = await createPendingSignInToken({
      auditMetadata: input.auditMetadata,
      method: input.method,
      profile: input.profile,
      returnTo: input.returnTo,
    });
    return { factors, kind: "second_factor", pendingToken };
  }
  await recordSignedIn(db, input.profile, {
    ...input.auditMetadata,
    method: input.method,
  });
  const token = await createSession(db, input.profile);
  return { kind: "session", token };
}

// Second factor satisfied: the session the first step withheld.
export async function completeSecondFactor(
  db: ReturnType<typeof createDb>,
  pending: PendingSignIn,
  secondFactor: SecondFactorMethod,
  extra: Record<string, unknown> = {},
) {
  await recordSignedIn(db, pending.profile, {
    ...pending.auditMetadata,
    method: pending.method,
    second_factor: secondFactor,
    ...extra,
  });
  return createSession(db, pending.profile);
}

async function recordSignedIn(
  db: ReturnType<typeof createDb>,
  profile: SessionProfile & { accountId: string },
  metadata: Record<string, unknown>,
) {
  await recordAuditEvent(db, {
    accountId: profile.accountId,
    actor: {
      accountId: profile.accountId,
      providerSubject: profile.providerSubject,
    },
    eventType: "account.signed_in",
    metadata,
    target: { providerIssuer: profile.providerIssuer },
  });
}

// Reads the pending-sign-in cookie from a second-factor route's request.
export async function pendingSignInFromRequest(request: NextRequest) {
  return readPendingSignInToken(
    request.cookies.get(pendingSignInCookieName)?.value,
  );
}

// The JSON response that turns a finished second factor into a session:
// session cookie on, pending cookie off, redirect where the first step was
// headed.
export function signedInResponse(
  sessionToken: string,
  returnTo: string | undefined,
  extra: Record<string, unknown> = {},
) {
  const response = NextResponse.json({
    ok: true,
    redirect: returnTo ?? "/account",
    ...extra,
  });
  response.cookies.set(sessionCookieName, sessionToken, sessionCookieOptions());
  response.cookies.set(pendingSignInCookieName, "", {
    ...pendingSignInCookieOptions(),
    maxAge: 0,
  });
  return response;
}

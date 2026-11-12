// The part of the app sign-in (app-sign-in.ts) that reads the browser
// session and the database: shared by GET /api/auth/app/authorize (signed in
// during this request: code at once) and its POST (the person pressed
// "Continue" on /login/app).

import { and, eq } from "drizzle-orm";
import { accountIdentities, type createDb } from "@frameos-cloud/db";
import {
  appSignInCallbackUrl,
  createAppSignInCode,
  type AppSignInRequest,
} from "./app-sign-in";
import { isRecent, sessionAuthenticatedAt } from "./recent-auth";
import { readSession, readSessionToken } from "./session";

export type AppSignInStep =
  // No usable browser session: sign in first, then come back.
  | { kind: "sign_in" }
  // The app asked for a fresh proof (sudo mode) and the session's is old.
  | { kind: "reauth" }
  // A session from before this request: ask before handing it on.
  | { kind: "confirm"; email: string | undefined }
  | { kind: "code"; redirect: string };

// Where the request stands with this browser's session. `confirmed` is the
// person's press of "Continue" on /login/app.
export async function appSignInStep(
  db: ReturnType<typeof createDb>,
  request: AppSignInRequest,
  confirmed: boolean,
): Promise<AppSignInStep> {
  const session = await readSession();
  // A personal API token is not a browser sign-in and is never handed on.
  if (!session?.accountId || session.apiToken) {
    return { kind: "sign_in" };
  }
  const authenticatedAt = await sessionAuthenticatedAt(db, await readSessionToken());
  if (!authenticatedAt) {
    return { kind: "sign_in" };
  }
  if (request.reauth && !isRecent(authenticatedAt)) {
    return { kind: "reauth" };
  }
  // Signed in (or re-proved) after the app asked: that was the consent.
  // The token's iat is in whole seconds, rounded down: one second of slack.
  const provedInThisRequest = authenticatedAt.getTime() >= (request.issuedAt - 1) * 1000;
  if (!provedInThisRequest && !confirmed) {
    return { email: session.email, kind: "confirm" };
  }

  const [identity] = await db
    .select({ id: accountIdentities.id })
    .from(accountIdentities)
    .where(
      and(
        eq(accountIdentities.accountId, session.accountId),
        eq(accountIdentities.providerIssuer, session.providerIssuer),
        eq(accountIdentities.providerSubject, session.providerSubject),
      ),
    )
    .limit(1);
  if (!identity) {
    return { kind: "sign_in" };
  }
  const code = await createAppSignInCode({
    accountId: session.accountId,
    authenticatedAt,
    challenge: request.challenge,
    identityId: identity.id,
  });
  return { kind: "code", redirect: appSignInCallbackUrl({ code, state: request.state }) };
}

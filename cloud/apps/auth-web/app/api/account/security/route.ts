import { eq } from "drizzle-orm";
import { accounts } from "@frameos-cloud/db";
import { NextRequest, NextResponse } from "next/server";
import { recordAuditEvent } from "../../../../src/lib/audit";
import { csrfResponse } from "../../../../src/lib/csrf";
import {
  jsonError,
  readJsonObject,
  requireDatabase,
} from "../../../../src/lib/device-flow";
import { rateLimitResponse } from "../../../../src/lib/rate-limit";
import {
  isSavedKeysReauthChoice,
  requireRecentAuth,
  savedKeysReauthChoices,
  savedKeysReauthIsLooser,
  savedKeysRevealMaxAge,
} from "../../../../src/lib/recent-auth";
import { readSession } from "../../../../src/lib/session";

export const runtime = "nodejs";

// What the Security page of the frames workspace
// (frontend/src/scenes/settings/account/SecurityPage.tsx) needs to know
// before it draws a form: whether the account has a password (the change
// and delete forms confirm with it; a Google-only account types its email),
// whether it is a superadmin (which may not delete itself), and the email
// to confirm with, and how long a sign-in lets the preview read the saved
// service keys (`saved_keys_reauth_seconds`, 0 = only at sign-in). The second
// factor's status is GET /api/account/two-factor.
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
      savedKeysReauthSeconds: accounts.savedKeysReauthSeconds,
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
      saved_keys_reauth_seconds:
        savedKeysRevealMaxAge(account.savedKeysReauthSeconds) ?? 0,
      saved_keys_reauth_choices: savedKeysReauthChoices,
    },
    { headers: { "cache-control": "no-store" } },
  );
}

// PUT {saved_keys_reauth_seconds}: how long a sign-in lets the in-browser
// preview read the saved service keys before it asks to confirm it is you
// (one of `savedKeysReauthChoices`). A browser session only: a token never
// reads the keys, so it has nothing to set. Asking MORE often is free; asking
// less often (a longer window, or none) is itself a sudo-mode action on the
// fifteen-minute window, or a cookie lifted from an unattended laptop could
// turn the gate off and then read every key.
export async function PUT(request: NextRequest) {
  const csrf = csrfResponse(request);
  if (csrf) {
    return csrf;
  }
  const limited = await rateLimitResponse(request, "account:security-write", {
    limit: 30,
    windowMs: 15 * 60 * 1000,
  });
  if (limited) {
    return limited;
  }
  const session = await readSession();
  if (!session?.accountId) {
    return jsonError("login_required", 401);
  }
  if (session.apiToken) {
    return jsonError("session_required", 403);
  }
  const { db, response } = requireDatabase();
  if (!db) {
    return response;
  }
  const body = await readJsonObject(request);
  const next = body.saved_keys_reauth_seconds;
  if (!isSavedKeysReauthChoice(next)) {
    return jsonError("invalid_request", 400, {
      detail: `saved_keys_reauth_seconds must be one of ${savedKeysReauthChoices.join(", ")}`,
    });
  }
  const [account] = await db
    .select({ savedKeysReauthSeconds: accounts.savedKeysReauthSeconds })
    .from(accounts)
    .where(eq(accounts.id, session.accountId))
    .limit(1);
  if (!account) {
    return jsonError("login_required", 401);
  }
  if (savedKeysReauthIsLooser(account.savedKeysReauthSeconds, next)) {
    const stale = await requireRecentAuth(db, session.accountId);
    if (stale) {
      return stale;
    }
  }
  await db
    .update(accounts)
    .set({ savedKeysReauthSeconds: next })
    .where(eq(accounts.id, session.accountId));
  await recordAuditEvent(db, {
    accountId: session.accountId,
    actor: { accountId: session.accountId, kind: "account" },
    eventType: "account.saved_keys_reauth_changed",
    metadata: {
      from: savedKeysRevealMaxAge(account.savedKeysReauthSeconds) ?? 0,
      to: next,
    },
    target: { accountId: session.accountId, kind: "account" },
  });
  return NextResponse.json(
    { saved_keys_reauth_seconds: next },
    { headers: { "cache-control": "no-store" } },
  );
}

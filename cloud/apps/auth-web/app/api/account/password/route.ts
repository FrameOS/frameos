import { and, eq, isNull, ne } from "drizzle-orm";
import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import {
  accounts,
  createDb,
  sessions,
  setAccountPassword,
} from "@frameos-cloud/db";
import { recordAuditEvent } from "../../../../src/lib/audit";
import { csrfResponse } from "../../../../src/lib/csrf";
import { assertDatabaseUrlConfigured } from "../../../../src/lib/env";
import {
  hashPassword,
  validatePasswordCandidate,
  verifyPasswordWithDummyFallback,
} from "../../../../src/lib/passwords";
import {
  identityRateLimitResponse,
  rateLimitResponse,
} from "../../../../src/lib/rate-limit";
import { hashSecret } from "../../../../src/lib/secrets";
import { readSession, sessionCookieName } from "../../../../src/lib/session";

// Change the signed-in account's password. Requires the current password, so
// a hijacked session alone cannot lock the owner out; accounts without a
// password (Google-only) go through the email reset flow instead, which
// proves control of the address.
export async function POST(request: NextRequest) {
  const csrf = csrfResponse(request);
  if (csrf) {
    return csrf;
  }

  const session = await readSession();
  if (!session?.accountId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const limited =
    (await rateLimitResponse(request, "account:password-change", {
      limit: 10,
      windowMs: 15 * 60 * 1000,
    })) ??
    (await identityRateLimitResponse(session.accountId, "account:password-change", {
      limit: 10,
      windowMs: 15 * 60 * 1000,
    }));
  if (limited) {
    return limited;
  }

  const body = (await request.json().catch(() => undefined)) as
    | { currentPassword?: unknown; newPassword?: unknown }
    | undefined;
  const currentPassword =
    typeof body?.currentPassword === "string" ? body.currentPassword : "";
  const newPassword =
    typeof body?.newPassword === "string" ? body.newPassword : "";
  if (!currentPassword || !newPassword) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const passwordProblem = validatePasswordCandidate(newPassword);
  if (passwordProblem) {
    return NextResponse.json(
      { error: "weak_password", message: passwordProblem },
      { status: 400 },
    );
  }

  assertDatabaseUrlConfigured();
  const db = createDb();

  const [account] = await db
    .select({ passwordHash: accounts.passwordHash })
    .from(accounts)
    .where(eq(accounts.id, session.accountId))
    .limit(1);
  if (!account) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const currentPasswordValid = await verifyPasswordWithDummyFallback(
    currentPassword,
    account.passwordHash,
  );
  if (!account.passwordHash) {
    return NextResponse.json({ error: "no_password" }, { status: 400 });
  }
  if (!currentPasswordValid) {
    return NextResponse.json({ error: "invalid_password" }, { status: 400 });
  }

  await setAccountPassword(
    db,
    session.accountId,
    await hashPassword(newPassword),
  );

  // Changing the password evicts every other session (a stolen session is a
  // likely reason to change it), but keeps this one signed in.
  const cookieStore = await cookies();
  const token = cookieStore.get(sessionCookieName)?.value;
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(sessions.accountId, session.accountId),
        isNull(sessions.revokedAt),
        ...(token ? [ne(sessions.tokenHash, hashSecret(token))] : []),
      ),
    );

  await recordAuditEvent(db, {
    accountId: session.accountId,
    actor: { accountId: session.accountId },
    eventType: "account.password_changed",
  });

  return NextResponse.json({ ok: true });
}

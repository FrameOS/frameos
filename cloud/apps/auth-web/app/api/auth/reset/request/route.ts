import {
  createDb,
  findAccountByPasswordEmail,
  findVerifiedGoogleAccountByEmail,
  normalizeEmail,
  passwordResetTokens,
} from "@frameos-cloud/db";
import { recordAuditEvent } from "../../../../../src/lib/audit";
import { NextRequest, NextResponse } from "next/server";
import { csrfResponse } from "../../../../../src/lib/csrf";
import { sendPasswordResetEmail } from "../../../../../src/lib/email";
import {
  assertDatabaseUrlConfigured,
  getBaseUrl,
} from "../../../../../src/lib/env";
import { createSecretToken, hashSecret } from "../../../../../src/lib/secrets";
import {
  identityRateLimitResponse,
  rateLimitResponse,
} from "../../../../../src/lib/rate-limit";

const resetTokenMaxAgeMs = 60 * 60 * 1000;

export async function POST(request: NextRequest) {
  const csrf = csrfResponse(request);
  if (csrf) {
    return csrf;
  }

  const limited = rateLimitResponse(request, "auth:reset-request", {
    limit: 10,
    windowMs: 60 * 60 * 1000,
  });
  if (limited) {
    return limited;
  }

  const body = (await request.json().catch(() => undefined)) as
    | { email?: unknown }
    | undefined;
  const email =
    typeof body?.email === "string" ? normalizeEmail(body.email) : "";
  if (!email) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const emailLimited = identityRateLimitResponse(
    email,
    "auth:reset-request-email",
    { limit: 5, windowMs: 60 * 60 * 1000 },
  );
  if (emailLimited) {
    return emailLimited;
  }

  assertDatabaseUrlConfigured();
  const db = createDb();
  // The reset flow also serves Google-first accounts adding their first
  // password: completing it creates a verified password identity.
  const passwordAccount = await findAccountByPasswordEmail(db, email);
  const accountId =
    passwordAccount?.id ??
    (await findVerifiedGoogleAccountByEmail(db, email))?.accountId;

  // Whether or not the email resolves to an account, respond identically so
  // the endpoint cannot be used to enumerate registered addresses.
  if (accountId) {
    const token = createSecretToken("frpr", 32);
    await db.insert(passwordResetTokens).values({
      accountId,
      expiresAt: new Date(Date.now() + resetTokenMaxAgeMs),
      tokenHash: hashSecret(token),
    });

    const resetUrl = new URL(
      `/recovery?token=${encodeURIComponent(token)}`,
      getBaseUrl(),
    ).toString();

    try {
      await sendPasswordResetEmail(email, resetUrl);
    } catch (error) {
      console.error(
        "auth/reset/request: sending reset email failed:",
        error instanceof Error ? error.message : "unknown error",
      );
    }

    await recordAuditEvent(db, {
      accountId,
      actor: { providerSubject: email },
      eventType: "account.password_reset_requested",
    });
  }

  return NextResponse.json({ ok: true });
}

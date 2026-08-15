import { and, eq, isNull } from "drizzle-orm";
import {
  createDb,
  emailVerificationTokens,
  markPasswordIdentityVerified,
} from "@frameos-cloud/db";
import { recordAuditEvent } from "./audit";
import { sendEmailVerificationEmail } from "./email";
import { getBaseUrl } from "./env";
import { reportError } from "./log";
import { createSecretToken, hashSecret } from "./secrets";

const verificationTokenMaxAgeMs = 24 * 60 * 60 * 1000;

// Failure to send must never fail the signup itself; the account works, the
// email just stays unverified until a later verification or password reset.
export async function beginEmailVerification(
  db: ReturnType<typeof createDb>,
  accountId: string,
  email: string,
) {
  const token = createSecretToken("frev", 32);
  await db.insert(emailVerificationTokens).values({
    accountId,
    expiresAt: new Date(Date.now() + verificationTokenMaxAgeMs),
    tokenHash: hashSecret(token),
  });

  const verifyUrl = new URL(
    `/verify-email?token=${encodeURIComponent(token)}`,
    getBaseUrl(),
  ).toString();

  try {
    await sendEmailVerificationEmail(email, verifyUrl);
  } catch (error) {
    // This is the single point of failure that gates every new signup: login
    // requires a verified email, so a bad Postmark token or a provider
    // outage silently locks out everyone who signs up during it, and the
    // user just sees "check your inbox". reportError, not console.error —
    // this has to reach the error tracker, because nobody is watching the
    // journal at 3am and the affected users cannot tell us.
    reportError("email.verification_send_failed", error, { accountId });
  }
}

export async function confirmEmailVerification(
  db: ReturnType<typeof createDb>,
  token: string,
): Promise<"verified" | "invalid"> {
  // Atomic single-use claim, mirroring the password reset flow.
  const [claimed] = await db
    .update(emailVerificationTokens)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(emailVerificationTokens.tokenHash, hashSecret(token)),
        isNull(emailVerificationTokens.usedAt),
      ),
    )
    .returning({
      accountId: emailVerificationTokens.accountId,
      expiresAt: emailVerificationTokens.expiresAt,
    });

  if (!claimed || claimed.expiresAt <= new Date()) {
    return "invalid";
  }

  await markPasswordIdentityVerified(db, claimed.accountId);
  await recordAuditEvent(db, {
    accountId: claimed.accountId,
    actor: { accountId: claimed.accountId },
    eventType: "account.email_verified",
  });

  return "verified";
}

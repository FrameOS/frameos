import { and, eq, isNull } from "drizzle-orm";
import {
  createDb,
  emailVerificationTokens,
  markPasswordIdentityVerified,
} from "@frameos-cloud/db";
import { recordAuditEvent } from "./audit";
import { sendEmailVerificationEmail } from "./email";
import { getBaseUrl } from "./env";
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
    console.error(
      "email-verification: sending verification email failed:",
      error instanceof Error ? error.message : "unknown error",
    );
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

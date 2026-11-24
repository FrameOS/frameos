import { type createDb, passwordResetTokens } from "@frameos-cloud/db";
import { recordAuditEvent } from "./audit";
import { sendPasswordResetEmail } from "./email";
import { getBaseUrl } from "./env";
import { reportError } from "./log";
import { createSecretToken, hashSecret } from "./secrets";

const resetTokenMaxAgeMs = 60 * 60 * 1000;

// The work a reset request does for an address that has an account: a token,
// the mail, the audit row. It runs after the answer has gone out
// (startPasswordResetMail), because how long it takes is the one thing that
// told a known address from an unknown one: the answer is the same, but a
// mail provider's round trip is hundreds of milliseconds.
const pending = new Set<Promise<void>>();

export function startPasswordResetMail(
  db: ReturnType<typeof createDb>,
  input: { accountId: string; email: string },
): void {
  const work = sendPasswordResetMail(db, input).finally(() => {
    pending.delete(work);
  });
  pending.add(work);
}

// Tests (and nothing else) wait for the mails a request started.
export async function waitForPendingPasswordResetMail(): Promise<void> {
  while (pending.size > 0) {
    await Promise.all([...pending]);
  }
}

async function sendPasswordResetMail(
  db: ReturnType<typeof createDb>,
  { accountId, email }: { accountId: string; email: string },
): Promise<void> {
  try {
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
      // The caller already has its answer, and it says nothing either way, so
      // the failure has to reach us by another route: the error tracker.
      // Never log the email address.
      reportError("email.password_reset_send_failed", error, { accountId });
    }

    await recordAuditEvent(db, {
      accountId,
      actor: { providerSubject: email },
      eventType: "account.password_reset_requested",
    });
  } catch (error) {
    reportError("auth.password_reset_request_failed", error, { accountId });
  }
}

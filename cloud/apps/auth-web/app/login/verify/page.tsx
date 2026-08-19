import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createDb } from "@frameos-cloud/db";
import { AuthCard } from "../../../src/components/AuthCard";
import { SecondFactorForm } from "../../../src/components/SecondFactorForm";
import { hasDatabaseUrl } from "../../../src/lib/env";
import {
  availableSecondFactors,
  pendingSignInCookieName,
  readPendingSignInToken,
} from "../../../src/lib/two-factor";

export const metadata = { title: "Two-factor verification" };

// The second step of sign-in. The pending cookie (minted by the password or
// Google step) says which account this is for; without one there is nothing
// to verify, so the page bounces back to /login.
export default async function LoginVerifyPage() {
  const cookieStore = await cookies();
  const pending = await readPendingSignInToken(
    cookieStore.get(pendingSignInCookieName)?.value,
  );
  if (!pending || !hasDatabaseUrl()) {
    redirect("/login?error=second_factor_expired");
  }
  const factors = await availableSecondFactors(
    createDb(),
    pending.profile.accountId,
  );
  if (!factors.enabled) {
    redirect("/login?error=second_factor_expired");
  }

  return (
    <AuthCard
      copy="Finish signing in with a passkey, a code from your authenticator app, or one of your recovery codes."
      eyebrow="One more step"
      title="Verify it's you"
    >
      <SecondFactorForm
        passkeys={factors.passkeys}
        recoveryCodes={factors.recoveryCodes}
        totp={factors.totp}
      />
    </AuthCard>
  );
}

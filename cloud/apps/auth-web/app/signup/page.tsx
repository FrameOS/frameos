import { AuthCard } from "../../src/components/AuthCard";
import { SignupForm } from "../../src/components/SignupForm";
import { safeAuthReturnPath } from "../../src/lib/auth-cookies";
import { hasGoogleOAuth } from "../../src/lib/env";
import { getTurnstileSiteKey } from "../../src/lib/turnstile";

export const metadata = { title: "Create your account" };

type SignupPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function SignupPage({ searchParams }: SignupPageProps) {
  const params = searchParams ? await searchParams : {};
  const rawReturnTo = Array.isArray(params.return_to)
    ? params.return_to[0]
    : params.return_to;
  const returnTo = safeAuthReturnPath(rawReturnTo);

  return (
    <AuthCard
      copy="Create a FrameOS Cloud account to link and manage your FrameOS backends."
      eyebrow="Sign up"
      title="Create your account"
    >
      <SignupForm
        googleEnabled={hasGoogleOAuth()}
        returnTo={returnTo}
        turnstileSiteKey={getTurnstileSiteKey()}
      />
    </AuthCard>
  );
}

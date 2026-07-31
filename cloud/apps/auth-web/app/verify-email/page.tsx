import { createDb } from "@frameos-cloud/db";
import { AuthCard } from "../../src/components/AuthCard";
import { confirmEmailVerification } from "../../src/lib/email-verification";
import { hasDatabaseUrl } from "../../src/lib/env";

export const metadata = { title: "Verify email" };

type VerifyEmailPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function VerifyEmailPage({
  searchParams,
}: VerifyEmailPageProps) {
  const params = searchParams ? await searchParams : {};
  const rawToken = Array.isArray(params.token) ? params.token[0] : params.token;
  const token = rawToken?.trim();

  const result =
    token && hasDatabaseUrl()
      ? await confirmEmailVerification(createDb(), token)
      : "invalid";

  if (result === "verified") {
    return (
      <AuthCard
        copy="Your email address is confirmed. Sign in to start using FrameOS Cloud."
        eyebrow="Email verified"
        title="You are all set"
      >
        <div className="actions">
          <a className="button button-primary" href="/login">
            Continue to sign in
          </a>
        </div>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      copy="This verification link is invalid, expired, or already used. If your email is already verified, just sign in. Otherwise, signing in with your password sends a fresh link."
      eyebrow="Email verification"
      title="Link not valid"
    >
      <div className="actions">
        <a className="button button-primary" href="/login">
          Go to sign in
        </a>
      </div>
    </AuthCard>
  );
}

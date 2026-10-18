import { AuthCard } from "../../src/components/AuthCard";
import { VerifyEmailForm } from "../../src/components/VerifyEmailForm";
import { safeAuthReturnPath } from "../../src/lib/auth-cookies";

export const metadata = { title: "Verify email" };

type VerifyEmailPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

// Rendering this page spends nothing: the token in the link is only consumed
// by the button's POST (/api/auth/verify-email), so a mail provider's link
// scanner cannot verify an address on the recipient's behalf.
export default async function VerifyEmailPage({
  searchParams,
}: VerifyEmailPageProps) {
  const params = searchParams ? await searchParams : {};
  const rawToken = Array.isArray(params.token) ? params.token[0] : params.token;
  const token = rawToken?.trim();
  // Set by the signup (or the sign-in that resent the link) the visitor came
  // from; the sign-in after verifying continues there.
  const returnTo = safeAuthReturnPath(
    Array.isArray(params.return_to) ? params.return_to[0] : params.return_to,
  );
  const loginHref = returnTo
    ? `/login?return_to=${encodeURIComponent(returnTo)}`
    : "/login";

  if (token) {
    return (
      <AuthCard
        copy="Press the button to confirm this is your email address."
        eyebrow="Email verification"
        title="Confirm your email"
      >
        <VerifyEmailForm loginHref={loginHref} token={token} />
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
        <a className="button button-primary" href={loginHref}>
          Go to sign in
        </a>
      </div>
    </AuthCard>
  );
}

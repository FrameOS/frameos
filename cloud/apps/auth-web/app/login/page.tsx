import { cookies } from "next/headers";
import { AuthCard } from "../../src/components/AuthCard";
import { LoginForm } from "../../src/components/LoginForm";
import {
  authCookieNames,
  safeAuthReturnPath,
} from "../../src/lib/auth-cookies";
import { hasGoogleOAuth } from "../../src/lib/env";

export const metadata = { title: "Sign in" };

type LoginPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = searchParams ? await searchParams : {};
  const error = readParam(params.error);
  const status = readParam(params.status);
  const returnTo = safeAuthReturnPath(readParam(params.return_to));

  // A Google sign-in that matched an unverified password account: the user
  // must prove they own the email (via password reset) before the accounts
  // may be linked. The email travels in a short-lived cookie, not the URL.
  if (error === "verify_before_google_link") {
    const cookieStore = await cookies();
    const mergeEmail = cookieStore.get(authCookieNames.mergeEmail)?.value;

    return (
      <AuthCard
        copy={`A FrameOS Cloud account already exists for ${
          mergeEmail ?? "this email"
        }, but its address was never verified. To keep that account safe, reset its password first — the emailed link proves the address is yours — then sign in with Google. The two sign-in methods will be linked automatically.`}
        eyebrow="Almost there"
        title="One quick step before linking Google"
      >
        <div className="actions">
          <a className="button button-primary" href="/reset">
            Reset password first
          </a>
          <a className="button" href="/login">
            Back to sign in
          </a>
        </div>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      copy={
        status
          ? statusMessage(status)
          : (error && errorMessage(error)) ??
            "Sign in with your FrameOS Cloud account."
      }
      eyebrow="Sign in"
      title="FrameOS Cloud"
    >
      <LoginForm googleEnabled={hasGoogleOAuth()} returnTo={returnTo} />
    </AuthCard>
  );
}

function readParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function errorMessage(error: string) {
  if (error === "google_unavailable") {
    return "Google sign-in is not configured for this environment yet.";
  }

  if (error === "provider_unavailable") {
    return "Google sign-in is unavailable. Try again in a moment, or use your password.";
  }

  if (error === "invalid_state") {
    return "The sign-in attempt expired or did not match this browser session. Try again.";
  }

  if (error === "access_denied") {
    return "Google sign-in was canceled. Try again when you are ready.";
  }

  if (error === "google_email_unverified") {
    return "Google could not confirm that email address, so it cannot be linked. Sign in with your password instead.";
  }

  // Never echo unrecognized error strings: the query parameter is
  // attacker-craftable, and arbitrary text rendered on the sign-in page is a
  // social-engineering vector even when safely escaped.
  return "Sign-in failed. Try again, and contact support if it keeps happening.";
}

function statusMessage(status: string) {
  if (status === "signed_out") {
    return "You are signed out.";
  }

  if (status === "account_deleted") {
    return "Your account and everything in it has been deleted. Thanks for trying FrameOS Cloud — you are welcome back any time.";
  }

  if (status === "reset_complete") {
    return "Your password was updated and your email is verified. Sign in with the new password — or with Google, which will now link automatically.";
  }

  return "The account flow finished. Sign in to continue.";
}

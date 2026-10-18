import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AuthCard } from "../../src/components/AuthCard";
import { LoginForm } from "../../src/components/LoginForm";
import {
  authCookieNames,
  safeAuthReturnPath,
} from "../../src/lib/auth-cookies";
import { getFramesUrl, hasGoogleOAuth } from "../../src/lib/env";
import { readSession } from "../../src/lib/session";

export const metadata = { title: "Sign in" };

type LoginPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = searchParams ? await searchParams : {};
  const error = readParam(params.error);
  const status = readParam(params.status);
  const returnTo = safeAuthReturnPath(readParam(params.return_to));

  // Already signed in: send them where they were headed instead of showing a
  // sign-in form to someone who is signed in. Stale links and cached redirects
  // land here — a browser that cached the old permanent /→/login redirect
  // never asks the server for the root again — and so does every "Sign in"
  // link followed in a second tab. An `error` means the caller has something
  // to say about this session (an unverified Google link, an expired flow), so
  // that page is still rendered. Only a code this page knows counts: the
  // query is attacker-craftable, and `?error=anything` must not be a way to
  // show a sign-in form to someone who is already signed in.
  if (!error || !isKnownLoginError(error)) {
    const session = await readSession();
    if (session) {
      redirect(returnTo ?? getFramesUrl());
    }
  }

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
        }, but its address was never verified. To keep that account safe, reset its password first — the emailed link proves the address is yours — then sign in with Google and confirm that password once to connect the two.`}
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

const loginErrorMessages: Record<string, string> = {
  access_denied: "Google sign-in was canceled. Try again when you are ready.",
  google_email_unverified:
    "Google has not verified that email address, so it cannot sign in here. Verify it with Google first, or sign up with a password.",
  google_link_expired: "The Google sign-in took too long to confirm. Start again.",
  google_unavailable: "Google sign-in is not configured for this environment yet.",
  invalid_state:
    "The sign-in attempt expired or did not match this browser session. Try again.",
  provider_unavailable:
    "Google sign-in is unavailable. Try again in a moment, or use your password.",
  second_factor_expired:
    "The two-factor step timed out. Sign in again to get a fresh one.",
};

function isKnownLoginError(error: string) {
  // verify_before_google_link has its own card rather than a line of copy.
  return (
    error === "verify_before_google_link" ||
    Object.hasOwn(loginErrorMessages, error)
  );
}

function errorMessage(error: string) {
  // Never echo unrecognized error strings: the query parameter is
  // attacker-craftable, and arbitrary text rendered on the sign-in page is a
  // social-engineering vector even when safely escaped.
  return Object.hasOwn(loginErrorMessages, error)
    ? loginErrorMessages[error]
    : "Sign-in failed. Try again, and contact support if it keeps happening.";
}

function statusMessage(status: string) {
  if (status === "signed_out") {
    return "You are signed out.";
  }

  if (status === "account_deleted") {
    return "Your account and everything in it has been deleted. Thanks for trying FrameOS Cloud — you are welcome back any time.";
  }

  if (status === "reset_complete") {
    return "Your password was updated and your email is verified. Sign in with the new password — or with Google, which will ask for that password once to connect the two.";
  }

  return "The account flow finished. Sign in to continue.";
}

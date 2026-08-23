"use client";

import { startAuthentication } from "@simplewebauthn/browser";
import { KeyRound, LogIn } from "lucide-react";
import posthog from "posthog-js";
import { useState } from "react";
import { defaultSignInRedirect } from "../lib/sign-in-redirect";

export function LoginForm({
  googleEnabled,
  returnTo,
}: {
  googleEnabled: boolean;
  returnTo?: string | undefined;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [submitting, setSubmitting] = useState(false);

  const googleHref = `/api/auth/google/start${
    returnTo ? `?return_to=${encodeURIComponent(returnTo)}` : ""
  }`;

  // Passwordless: a discoverable passkey with user verification is the whole
  // sign-in. The browser lists the matching passkeys; the server learns the
  // account from the credential that answers.
  async function signInWithPasskey() {
    setSubmitting(true);
    setError(undefined);
    try {
      const optionsResponse = await fetch("/api/auth/passkey/options", {
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const optionsPayload = (await optionsResponse
        .json()
        .catch(() => undefined)) as
        | { options?: Parameters<typeof startAuthentication>[0]["optionsJSON"] }
        | undefined;
      if (!optionsResponse.ok || !optionsPayload?.options) {
        setError(
          optionsResponse.status === 429
            ? "Too many attempts. Wait a few minutes and try again."
            : "Passkey sign-in is unavailable right now. Use your password.",
        );
        setSubmitting(false);
        return;
      }
      const assertion = await startAuthentication({
        optionsJSON: optionsPayload.options,
      });
      const response = await fetch("/api/auth/passkey/verify", {
        body: JSON.stringify({
          response: assertion,
          ...(returnTo ? { return_to: returnTo } : {}),
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      if (response.ok) {
        const payload = (await response.json()) as { redirect?: string };
        posthog.capture("user_logged_in", { method: "passkey" });
        window.location.assign(payload.redirect ?? defaultSignInRedirect);
        return;
      }
      setError(
        response.status === 429
          ? "Too many attempts. Wait a few minutes and try again."
          : "That passkey is not registered with a FrameOS Cloud account, or could not be verified.",
      );
    } catch (caught) {
      setError(
        caught instanceof Error && caught.name === "NotAllowedError"
          ? "Passkey prompt was cancelled."
          : "Passkeys are not available on this device or browser.",
      );
    }
    setSubmitting(false);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);

    try {
      const response = await fetch("/api/auth/login", {
        body: JSON.stringify({
          email,
          password,
          ...(returnTo ? { return_to: returnTo } : {}),
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });

      if (response.ok) {
        const payload = (await response.json()) as { redirect?: string };
        posthog.capture("user_logged_in", { method: "password" });
        window.location.assign(payload.redirect ?? defaultSignInRedirect);
        return;
      }

      const payload = (await response.json().catch(() => undefined)) as
        | { error?: string }
        | undefined;
      if (payload?.error === "email_unverified") {
        setError(
          "Your email address is not verified yet. We just sent a fresh verification link to your inbox — click it, then sign in again.",
        );
      } else if (response.status === 401) {
        setError("Wrong email or password.");
      } else if (response.status === 429) {
        setError("Too many attempts. Wait a few minutes and try again.");
      } else {
        setError("Sign-in failed. Try again in a moment.");
      }
    } catch {
      setError("Sign-in failed. Try again in a moment.");
    }
    setSubmitting(false);
  }

  return (
    <form className="auth-form" onSubmit={(event) => void submit(event)}>
      {error ? (
        <p className="notice-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="field">
        <label htmlFor="login-email">Email</label>
        <input
          autoComplete="email"
          className="input"
          id="login-email"
          onChange={(event) => setEmail(event.target.value)}
          required
          type="email"
          value={email}
        />
      </div>
      <div className="field">
        <label htmlFor="login-password">Password</label>
        <input
          autoComplete="current-password"
          className="input"
          id="login-password"
          onChange={(event) => setPassword(event.target.value)}
          required
          type="password"
          value={password}
        />
      </div>
      <div className="actions">
        <button
          className="button button-primary"
          disabled={submitting}
          type="submit"
        >
          <LogIn aria-hidden size={18} />
          {submitting ? "Signing in…" : "Sign in"}
        </button>
        <button
          className="button"
          disabled={submitting}
          onClick={() => void signInWithPasskey()}
          type="button"
        >
          <KeyRound aria-hidden size={18} />
          Sign in with a passkey
        </button>
        {googleEnabled ? (
          <a
            className="button"
            href={googleHref}
            onClick={() => posthog.capture("google_sign_in_started")}
          >
            Continue with Google
          </a>
        ) : null}
      </div>
      <div className="footer-links">
        <a href="/signup">Create an account</a>
        <a href="/reset">Forgot password?</a>
      </div>
    </form>
  );
}

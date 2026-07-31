"use client";

import { UserPlus } from "lucide-react";
import posthog from "posthog-js";
import { useState } from "react";

export function SignupForm({
  googleEnabled,
  returnTo,
}: {
  googleEnabled: boolean;
  returnTo?: string | undefined;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [submitting, setSubmitting] = useState(false);
  const [created, setCreated] = useState(false);

  const googleHref = `/api/auth/google/start${
    returnTo ? `?return_to=${encodeURIComponent(returnTo)}` : ""
  }`;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);

    try {
      const response = await fetch("/api/auth/signup", {
        body: JSON.stringify({
          email,
          name,
          password,
          ...(returnTo ? { return_to: returnTo } : {}),
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });

      if (response.ok) {
        posthog.capture("user_signed_up", { method: "password" });
        setCreated(true);
        return;
      }

      const payload = (await response.json().catch(() => undefined)) as
        | { error?: string; message?: string }
        | undefined;
      if (payload?.error === "email_taken") {
        setError("An account with this email already exists. Sign in instead.");
      } else if (payload?.error === "email_taken_google") {
        setError(
          "This email already signs in with Google. Use the Google button to sign in — or, to add a password to that account, use “Forgot password?” on the sign-in page.",
        );
      } else if (payload?.error === "weak_password" && payload.message) {
        setError(payload.message);
      } else if (response.status === 429) {
        setError("Too many attempts. Wait a few minutes and try again.");
      } else {
        setError("Signup failed. Check the form and try again.");
      }
    } catch {
      setError("Signup failed. Try again in a moment.");
    }
    setSubmitting(false);
  }

  if (created) {
    return (
      <div className="auth-form">
        <p className="copy">
          Your account is created. We sent a verification link to{" "}
          <strong>{email}</strong> — click it, then sign in.
        </p>
        <div className="actions">
          <a className="button button-primary" href="/login">
            Go to sign in
          </a>
        </div>
      </div>
    );
  }

  return (
    <form className="auth-form" onSubmit={(event) => void submit(event)}>
      {error ? (
        <p className="notice-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="field">
        <label htmlFor="signup-name">Name</label>
        <input
          autoComplete="name"
          className="input"
          id="signup-name"
          onChange={(event) => setName(event.target.value)}
          type="text"
          value={name}
        />
      </div>
      <div className="field">
        <label htmlFor="signup-email">Email</label>
        <input
          autoComplete="email"
          className="input"
          id="signup-email"
          onChange={(event) => setEmail(event.target.value)}
          required
          type="email"
          value={email}
        />
      </div>
      <div className="field">
        <label htmlFor="signup-password">Password</label>
        <input
          autoComplete="new-password"
          className="input"
          id="signup-password"
          minLength={8}
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
          <UserPlus aria-hidden size={18} />
          {submitting ? "Creating account…" : "Create account"}
        </button>
        {googleEnabled ? (
          <a className="button" href={googleHref}>
            Continue with Google
          </a>
        ) : null}
      </div>
      <div className="footer-links">
        <a href="/login">Already have an account? Sign in</a>
      </div>
    </form>
  );
}

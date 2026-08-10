"use client";

import { LogIn } from "lucide-react";
import posthog from "posthog-js";
import { useState } from "react";

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
        window.location.assign(payload.redirect ?? "/account");
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

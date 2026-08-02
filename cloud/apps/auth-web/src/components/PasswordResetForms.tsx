"use client";

import { KeyRound, MailQuestion } from "lucide-react";
import { useState } from "react";

export function RequestResetForm({
  initialEmail = "",
}: {
  initialEmail?: string;
}) {
  const [email, setEmail] = useState(initialEmail);
  const [state, setState] = useState<"idle" | "submitting" | "sent">("idle");
  const [error, setError] = useState<string | undefined>();

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setState("submitting");
    setError(undefined);

    try {
      const response = await fetch("/api/auth/reset/request", {
        body: JSON.stringify({ email }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });

      if (response.ok) {
        setState("sent");
        return;
      }

      setError(
        response.status === 429
          ? "Too many attempts. Wait a few minutes and try again."
          : "Something went wrong. Try again in a moment.",
      );
    } catch {
      setError("Something went wrong. Try again in a moment.");
    }
    setState("idle");
  }

  if (state === "sent") {
    return (
      <p className="copy">
        If an account exists for that email, a reset link is on its way. The
        link is valid for one hour.
      </p>
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
        <label htmlFor="reset-email">Email</label>
        <input
          autoComplete="email"
          className="input"
          id="reset-email"
          onChange={(event) => setEmail(event.target.value)}
          required
          type="email"
          value={email}
        />
      </div>
      <div className="actions">
        <button
          className="button button-primary"
          disabled={state === "submitting"}
          type="submit"
        >
          <MailQuestion aria-hidden size={18} />
          {state === "submitting" ? "Sending…" : "Send reset link"}
        </button>
      </div>
      <div className="footer-links">
        <a href="/login">Back to sign in</a>
      </div>
    </form>
  );
}

export function ConfirmResetForm({ token }: { token: string }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);

    try {
      const response = await fetch("/api/auth/reset/confirm", {
        body: JSON.stringify({ password, token }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });

      if (response.ok) {
        window.location.assign("/login?status=reset_complete");
        return;
      }

      const payload = (await response.json().catch(() => undefined)) as
        | { error?: string; message?: string }
        | undefined;
      if (payload?.error === "invalid_token") {
        setError(
          "This reset link is invalid, expired, or already used. Request a new one.",
        );
      } else if (payload?.error === "weak_password" && payload.message) {
        setError(payload.message);
      } else {
        setError("Something went wrong. Try again in a moment.");
      }
    } catch {
      setError("Something went wrong. Try again in a moment.");
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
        <label htmlFor="recovery-password">New password</label>
        <input
          autoComplete="new-password"
          className="input"
          id="recovery-password"
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
          <KeyRound aria-hidden size={18} />
          {submitting ? "Saving…" : "Set new password"}
        </button>
      </div>
      <div className="footer-links">
        <a href="/reset">Request a new link</a>
      </div>
    </form>
  );
}

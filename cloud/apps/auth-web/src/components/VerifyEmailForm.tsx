"use client";

import { MailCheck } from "lucide-react";
import { useState } from "react";

// The verification link lands here with its token; the token is only spent
// when the person presses the button (see /api/auth/verify-email for why a
// GET must not do it).
export function VerifyEmailForm({ token }: { token: string }) {
  const [state, setState] = useState<
    "idle" | "submitting" | "verified" | "invalid" | "error"
  >("idle");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setState("submitting");
    try {
      const response = await fetch("/api/auth/verify-email", {
        body: JSON.stringify({ token }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      if (response.ok) {
        setState("verified");
        return;
      }
      setState(response.status === 400 ? "invalid" : "error");
    } catch {
      setState("error");
    }
  }

  if (state === "verified") {
    return (
      <>
        <p className="copy">
          Your email address is confirmed. Sign in to start using FrameOS
          Cloud.
        </p>
        <div className="actions">
          <a className="button button-primary" href="/login">
            Continue to sign in
          </a>
        </div>
      </>
    );
  }

  if (state === "invalid") {
    return (
      <>
        <p className="copy">
          This verification link is invalid, expired, or already used. If your
          email is already verified, just sign in. Otherwise, signing in with
          your password sends a fresh link.
        </p>
        <div className="actions">
          <a className="button button-primary" href="/login">
            Go to sign in
          </a>
        </div>
      </>
    );
  }

  return (
    <form className="auth-form" onSubmit={(event) => void submit(event)}>
      {state === "error" ? (
        <p className="notice-error" role="alert">
          Something went wrong. Try again in a moment.
        </p>
      ) : null}
      <div className="actions">
        <button
          className="button button-primary"
          disabled={state === "submitting"}
          type="submit"
        >
          <MailCheck aria-hidden="true" size={16} />
          {state === "submitting" ? "Confirming…" : "Confirm my email"}
        </button>
      </div>
    </form>
  );
}

"use client";

import { KeyRound } from "lucide-react";
import { useState } from "react";

export function ChangePasswordForm() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [state, setState] = useState<"idle" | "submitting" | "done">("idle");
  const [error, setError] = useState<string | undefined>();

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setState("submitting");
    setError(undefined);

    try {
      const response = await fetch("/api/account/password", {
        body: JSON.stringify({ currentPassword, newPassword }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });

      if (response.ok) {
        setCurrentPassword("");
        setNewPassword("");
        setState("done");
        return;
      }

      const payload = (await response.json().catch(() => undefined)) as
        | { error?: string; message?: string }
        | undefined;
      if (payload?.error === "invalid_password") {
        setError("The current password is incorrect.");
      } else if (payload?.error === "weak_password" && payload.message) {
        setError(payload.message);
      } else if (payload?.error === "no_password") {
        setError(
          "This account has no password yet — use the password reset flow instead.",
        );
      } else if (response.status === 429) {
        setError("Too many attempts. Wait a few minutes and try again.");
      } else {
        setError("Something went wrong. Try again in a moment.");
      }
    } catch {
      setError("Something went wrong. Try again in a moment.");
    }
    setState("idle");
  }

  return (
    <form className="auth-form" onSubmit={(event) => void submit(event)}>
      {error ? (
        <p className="notice-error" role="alert">
          {error}
        </p>
      ) : null}
      {state === "done" ? (
        <p className="notice" role="status">
          Password changed. Other signed-in sessions were signed out.
        </p>
      ) : null}
      <div className="field">
        <label htmlFor="current-password">Current password</label>
        <input
          autoComplete="current-password"
          className="input"
          id="current-password"
          onChange={(event) => setCurrentPassword(event.target.value)}
          required
          type="password"
          value={currentPassword}
        />
      </div>
      <div className="field">
        <label htmlFor="new-password">New password</label>
        <input
          autoComplete="new-password"
          className="input"
          id="new-password"
          minLength={8}
          onChange={(event) => setNewPassword(event.target.value)}
          required
          type="password"
          value={newPassword}
        />
      </div>
      <div className="actions">
        <button
          className="button button-primary"
          disabled={state === "submitting"}
          type="submit"
        >
          <KeyRound aria-hidden size={18} />
          {state === "submitting" ? "Changing…" : "Change password"}
        </button>
      </div>
    </form>
  );
}

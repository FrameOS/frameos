"use client";

import { Trash2 } from "lucide-react";
import { useState } from "react";

// Self-serve erasure. Two deliberate frictions and no more: you have to open
// the form, and you have to re-authenticate. No "type DELETE to confirm"
// theatre on top — the re-auth already proves intent, and stacked
// confirmations train people to click through them.

export function DeleteAccountForm({
  hasPassword,
  isSuperadmin,
  primaryEmail,
}: {
  /** Password accounts confirm with the password; others type their email. */
  hasPassword: boolean;
  isSuperadmin: boolean;
  primaryEmail: string | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmEmail, setConfirmEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>();

  if (isSuperadmin) {
    return (
      <p className="copy">
        This account is a superadmin. Hand the superadmin flag to someone else
        (or have another superadmin remove yours) before deleting it — the
        admin panel must never end up with no way in.
      </p>
    );
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);

    try {
      const response = await fetch("/api/account/delete", {
        body: JSON.stringify({ confirmEmail, password }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });

      if (response.ok) {
        // The session cookie is already cleared by the response; a full
        // navigation (not a router push) makes sure no cached RSC payload for
        // the now-deleted account is rendered on the way out.
        window.location.assign("/login?status=account_deleted");
        return;
      }

      const payload = (await response.json().catch(() => undefined)) as
        | { error?: string }
        | undefined;
      if (payload?.error === "invalid_password") {
        setError("That password is not correct.");
      } else if (payload?.error === "invalid_confirmation") {
        setError("That is not the email address on this account.");
      } else if (payload?.error === "superadmin_cannot_self_delete") {
        setError(
          "Superadmin accounts cannot delete themselves. Hand over the flag first.",
        );
      } else if (response.status === 429) {
        setError("Too many attempts. Wait a few minutes and try again.");
      } else {
        setError("Something went wrong. Try again in a moment.");
      }
    } catch {
      setError("Something went wrong. Try again in a moment.");
    }
    setSubmitting(false);
  }

  if (!open) {
    return (
      <div className="actions">
        <button
          className="button button-danger"
          onClick={() => setOpen(true)}
          type="button"
        >
          <Trash2 aria-hidden size={18} />
          Delete my account
        </button>
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
      <p className="copy">
        This permanently deletes your account, your frames, your scenes
        (including any you have published to the store), your uploaded files
        and your backups. It happens immediately and cannot be undone.
        Off-site backups roll over within 30 days.
      </p>
      <p className="copy">
        <strong>Export your data first</strong> if you want a copy — the button
        is right above this one.
      </p>
      {hasPassword ? (
        <div className="field">
          <label htmlFor="delete-password">Confirm your password</label>
          <input
            autoComplete="current-password"
            className="input"
            id="delete-password"
            onChange={(event) => setPassword(event.target.value)}
            required
            type="password"
            value={password}
          />
        </div>
      ) : (
        <div className="field">
          <label htmlFor="delete-confirm-email">
            Type <strong>{primaryEmail}</strong> to confirm
          </label>
          <input
            autoComplete="off"
            className="input"
            id="delete-confirm-email"
            onChange={(event) => setConfirmEmail(event.target.value)}
            required
            type="email"
            value={confirmEmail}
          />
        </div>
      )}
      <div className="actions">
        <button
          className="button button-danger"
          disabled={submitting}
          type="submit"
        >
          <Trash2 aria-hidden size={18} />
          {submitting ? "Deleting…" : "Delete my account permanently"}
        </button>
        <button
          className="button"
          onClick={() => {
            setOpen(false);
            setError(undefined);
            setPassword("");
            setConfirmEmail("");
          }}
          type="button"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

"use client";

import { Link2 } from "lucide-react";
import { useState } from "react";

// Client half of /login/link-google. The pending-link cookie rides along
// with the request, so the form only sends the password; on success the
// server has linked the identity and minted a session (or parked a pending
// sign-in for the second factor) and the browser follows the redirect.
export function GoogleLinkForm() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  function explain(response: Response, payload: { error?: string } | undefined) {
    if (payload?.error === "invalid_password") {
      return "That password is not correct.";
    }
    if (payload?.error === "link_expired") {
      return "This Google sign-in has expired. Start again from the sign-in page.";
    }
    if (payload?.error === "link_conflict") {
      return "This Google account is already connected to a different FrameOS Cloud account.";
    }
    if (response.status === 429) {
      return "Too many attempts. Wait a few minutes and try again.";
    }
    return "Something went wrong. Try again in a moment.";
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch("/api/auth/google/link", {
        body: JSON.stringify({ password }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json().catch(() => undefined)) as
        | { error?: string; redirect?: string }
        | undefined;
      if (response.ok) {
        window.location.assign(payload?.redirect ?? "/");
        return;
      }
      setError(explain(response, payload));
    } catch {
      setError("Something went wrong. Try again in a moment.");
    }
    setBusy(false);
  }

  return (
    <form className="auth-form" onSubmit={(event) => void submit(event)}>
      {error ? (
        <p className="notice-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="field">
        <label htmlFor="google-link-password">Password</label>
        <input
          autoComplete="current-password"
          autoFocus
          className="input"
          id="google-link-password"
          onChange={(event) => setPassword(event.target.value)}
          required
          type="password"
          value={password}
        />
      </div>
      <div className="actions">
        <button className="button button-primary" disabled={busy} type="submit">
          <Link2 aria-hidden size={18} />
          {busy ? "Connecting…" : "Connect Google sign-in"}
        </button>
      </div>
      <div className="footer-links">
        <a href="/reset">Forgot password?</a>
        <a href="/login">Cancel</a>
      </div>
    </form>
  );
}

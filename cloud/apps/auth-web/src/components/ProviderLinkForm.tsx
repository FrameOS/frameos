"use client";

import { Link2, LogIn } from "lucide-react";
import { useState } from "react";

const signInHere = `/login?return_to=${encodeURIComponent("/login/link")}`;

// Client half of /login/link. The pending-link cookie rides along with every
// request; what the visitor proves the account with depends on `mode`:
// - "password": the account's password (and, below it, "sign in another way"
//   when the account has other ways in).
// - "sign_in": no password on the account: sign in to it on the sign-in page,
//   which comes back to /login/link.
// - "session": signed in to that account just now: one button, the session is
//   the proof.
// - "switch": another account is signed in here: sign out, then sign in.
// On success the server has linked the identity and minted a session (or
// parked a pending sign-in for the second factor) and the browser follows the
// redirect.
export function ProviderLinkForm({
  method,
  mode,
  otherWays,
  provider,
}: {
  // "Google sign-in", "Sign in with Apple".
  method: string;
  mode: "password" | "session" | "sign_in" | "switch";
  // "Google or a passkey": the account's ways in besides a password.
  otherWays?: string | undefined;
  // "Google", "Apple".
  provider: string;
}) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  function explain(response: Response, payload: { error?: string } | undefined) {
    if (payload?.error === "invalid_password") {
      return "That password is not correct.";
    }
    if (payload?.error === "link_expired") {
      return `This ${provider} sign-in has expired. Start again from the sign-in page.`;
    }
    if (payload?.error === "link_conflict") {
      return `This ${provider} account is already connected to a different FrameOS Cloud account.`;
    }
    if (payload?.error === "wrong_account") {
      return "This browser is signed in to a different account. Reload the page.";
    }
    if (response.status === 429) {
      return "Too many attempts. Wait a few minutes and try again.";
    }
    return "Something went wrong. Try again in a moment.";
  }

  async function connect(body: Record<string, string>) {
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch("/api/auth/link", {
        body: JSON.stringify(body),
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
      // The session aged past the window meanwhile: this page offers
      // "Confirm it's you" on a reload.
      if (payload?.error === "reauth_required") {
        window.location.reload();
        return;
      }
      setError(explain(response, payload));
    } catch {
      setError("Something went wrong. Try again in a moment.");
    }
    setBusy(false);
  }

  async function signOutAndSignIn() {
    setBusy(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      window.location.assign(signInHere);
    }
  }

  const errorNotice = error ? (
    <p className="notice-error" role="alert">
      {error}
    </p>
  ) : null;

  if (mode === "session") {
    return (
      <div className="auth-form">
        {errorNotice}
        <div className="actions">
          <button
            className="button button-primary"
            disabled={busy}
            onClick={() => void connect({})}
            type="button"
          >
            <Link2 aria-hidden size={18} />
            {busy ? "Connecting…" : `Connect ${method}`}
          </button>
          <a className="button" href="/login">
            Cancel
          </a>
        </div>
      </div>
    );
  }

  if (mode === "switch" || mode === "sign_in") {
    return (
      <div className="auth-form">
        {errorNotice}
        <div className="actions">
          {mode === "switch" ? (
            <button
              className="button button-primary"
              disabled={busy}
              onClick={() => void signOutAndSignIn()}
              type="button"
            >
              <LogIn aria-hidden size={18} />
              Sign out and continue
            </button>
          ) : (
            <a className="button button-primary" href={signInHere}>
              <LogIn aria-hidden size={18} />
              {otherWays ? `Sign in with ${otherWays}` : "Sign in"}
            </a>
          )}
          <a className="button" href="/login">
            Cancel
          </a>
        </div>
      </div>
    );
  }

  return (
    <form
      className="auth-form"
      onSubmit={(event) => {
        event.preventDefault();
        void connect({ password });
      }}
    >
      {errorNotice}
      <div className="field">
        <label htmlFor="link-password">Password</label>
        <input
          autoComplete="current-password"
          autoFocus
          className="input"
          id="link-password"
          onChange={(event) => setPassword(event.target.value)}
          required
          type="password"
          value={password}
        />
      </div>
      <div className="actions">
        <button className="button button-primary" disabled={busy} type="submit">
          <Link2 aria-hidden size={18} />
          {busy ? "Connecting…" : `Connect ${method}`}
        </button>
      </div>
      <div className="footer-links">
        {otherWays ? <a href={signInHere}>Sign in with {otherWays} instead</a> : null}
        <a href="/reset">Forgot password?</a>
        <a href="/login">Cancel</a>
      </div>
    </form>
  );
}

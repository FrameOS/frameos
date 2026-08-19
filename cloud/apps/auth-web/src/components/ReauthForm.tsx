"use client";

import { startAuthentication } from "@simplewebauthn/browser";
import { KeyRound, ShieldCheck } from "lucide-react";
import { useState } from "react";
import type { ReauthMethods } from "../lib/recent-auth";

type Mode = "code" | "password" | "recovery";

// Client half of /login/reauth. The session cookie rides along with every
// request, so the form only sends the proof; on success the server has
// stamped the session and the browser goes back to `returnTo`.
export function ReauthForm({
  email,
  googleEnabled,
  methods,
  returnTo,
}: {
  email?: string | undefined;
  googleEnabled: boolean;
  methods: ReauthMethods;
  returnTo: string;
}) {
  const [mode, setMode] = useState<Mode>(
    methods.password ? "password" : "code",
  );
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const googleHref = `/api/auth/google/start?reauth=1&return_to=${encodeURIComponent(returnTo)}`;

  function finish(payload: { redirect?: string }) {
    window.location.assign(payload.redirect ?? returnTo);
  }

  function explain(response: Response, payload: { error?: string } | undefined) {
    if (payload?.error === "login_required") {
      return "Your session has ended. Sign in again to continue.";
    }
    if (payload?.error === "invalid_password") {
      return "That password is not correct.";
    }
    if (payload?.error === "invalid_code") {
      return mode === "recovery"
        ? "That recovery code is not valid (or was already used)."
        : "That code is not valid. Codes change every 30 seconds — try the current one.";
    }
    if (payload?.error === "invalid_passkey" || payload?.error === "challenge_expired") {
      return "The passkey could not be verified. Try again.";
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
      const response = await fetch("/api/auth/reauth", {
        body: JSON.stringify({
          ...(mode === "password" ? { password: secret } : { code: secret }),
          return_to: returnTo,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json().catch(() => undefined)) as
        | { error?: string; redirect?: string }
        | undefined;
      if (response.ok) {
        finish(payload ?? {});
        return;
      }
      setError(explain(response, payload));
    } catch {
      setError("Something went wrong. Try again in a moment.");
    }
    setBusy(false);
  }

  async function usePasskey() {
    setBusy(true);
    setError(undefined);
    try {
      const optionsResponse = await fetch("/api/auth/reauth/passkey/options", {
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const optionsPayload = (await optionsResponse
        .json()
        .catch(() => undefined)) as
        | { error?: string; options?: Parameters<typeof startAuthentication>[0]["optionsJSON"] }
        | undefined;
      if (!optionsResponse.ok || !optionsPayload?.options) {
        setError(explain(optionsResponse, optionsPayload));
        setBusy(false);
        return;
      }
      const assertion = await startAuthentication({
        optionsJSON: optionsPayload.options,
      });
      const response = await fetch("/api/auth/reauth/passkey/verify", {
        body: JSON.stringify({ response: assertion, return_to: returnTo }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json().catch(() => undefined)) as
        | { error?: string; redirect?: string }
        | undefined;
      if (response.ok) {
        finish(payload ?? {});
        return;
      }
      setError(explain(response, payload));
    } catch (caught) {
      // The browser cancelled or no matching passkey — not a server error.
      setError(
        caught instanceof Error && caught.name === "NotAllowedError"
          ? "Passkey prompt was cancelled."
          : "The passkey could not be used on this device.",
      );
    }
    setBusy(false);
  }

  const hasForm = methods.password || methods.code;
  const alternatives: { label: string; mode: Mode }[] = [];
  if (methods.password && mode !== "password") {
    alternatives.push({ label: "Use my password instead", mode: "password" });
  }
  if (methods.code && mode !== "code") {
    alternatives.push({ label: "Use my authenticator app instead", mode: "code" });
  }
  if (methods.code && mode !== "recovery") {
    alternatives.push({ label: "Use a recovery code instead", mode: "recovery" });
  }

  return (
    <div className="stack-lg">
      {email ? (
        <p className="copy">
          Signed in as <strong>{email}</strong>.
        </p>
      ) : null}
      {error ? (
        <p className="notice-error" role="alert">
          {error}
        </p>
      ) : null}
      {methods.passkey ? (
        <div className="actions">
          <button
            className="button button-primary"
            disabled={busy}
            onClick={() => void usePasskey()}
            type="button"
          >
            <KeyRound aria-hidden size={18} />
            {busy ? "Waiting for passkey…" : "Confirm with a passkey"}
          </button>
        </div>
      ) : null}
      {methods.passkey && hasForm ? <div className="divider" /> : null}
      {hasForm ? (
        <form className="auth-form" onSubmit={(event) => void submit(event)}>
          <div className="field">
            <label htmlFor="reauth-secret">
              {mode === "password"
                ? "Password"
                : mode === "recovery"
                  ? "Recovery code"
                  : "Authenticator code"}
            </label>
            <input
              autoComplete={mode === "password" ? "current-password" : "one-time-code"}
              autoFocus={!methods.passkey}
              className={mode === "password" ? "input" : "input code-input"}
              id="reauth-secret"
              inputMode={mode === "code" ? "numeric" : "text"}
              onChange={(event) => setSecret(event.target.value)}
              pattern={mode === "code" ? "[0-9 ]*" : undefined}
              placeholder={
                mode === "password" ? undefined : mode === "recovery" ? "xxxxx-xxxxx" : "123 456"
              }
              required
              type={mode === "password" ? "password" : "text"}
              value={secret}
            />
          </div>
          <div className="actions">
            <button className="button button-primary" disabled={busy} type="submit">
              <ShieldCheck aria-hidden size={18} />
              {busy ? "Verifying…" : "Confirm"}
            </button>
          </div>
          <div className="footer-links">
            {alternatives.map((alternative) => (
              <button
                className="footer-link-button"
                key={alternative.mode}
                onClick={() => {
                  setMode(alternative.mode);
                  setSecret("");
                  setError(undefined);
                }}
                type="button"
              >
                {alternative.label}
              </button>
            ))}
            <a href={returnTo}>Cancel</a>
          </div>
        </form>
      ) : null}
      {methods.sign_in ? (
        <div className="stack-lg">
          <p className="copy">
            This account has no password or second factor to check, so sign in
            with Google once more to continue.
          </p>
          <div className="actions">
            {googleEnabled ? (
              <a className="button button-primary" href={googleHref}>
                Continue with Google
              </a>
            ) : (
              <a className="button button-primary" href="/reset">
                Set a password first
              </a>
            )}
          </div>
          <div className="footer-links">
            <a href={returnTo}>Cancel</a>
          </div>
        </div>
      ) : null}
    </div>
  );
}

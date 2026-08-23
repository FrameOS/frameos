"use client";

import { startAuthentication } from "@simplewebauthn/browser";
import { KeyRound, LogIn } from "lucide-react";
import posthog from "posthog-js";
import { useState } from "react";
import { defaultSignInRedirect } from "../lib/sign-in-redirect";

type Mode = "code" | "recovery";

// Client half of /login/verify. The pending-sign-in cookie rides along with
// every request, so the form only sends the proof.
export function SecondFactorForm({
  passkeys,
  recoveryCodes,
  totp,
}: {
  passkeys: boolean;
  recoveryCodes: boolean;
  totp: boolean;
}) {
  const [mode, setMode] = useState<Mode>(totp ? "code" : "recovery");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  function finish(payload: { redirect?: string }) {
    posthog.capture("user_logged_in", { method: "second_factor" });
    window.location.assign(payload.redirect ?? defaultSignInRedirect);
  }

  function explain(response: Response, payload: { error?: string } | undefined) {
    if (payload?.error === "sign_in_expired") {
      return "This sign-in attempt expired. Start again from the sign-in page.";
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

  async function submitCode(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch("/api/auth/second-factor/code", {
        body: JSON.stringify({ code }),
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
      const optionsResponse = await fetch(
        "/api/auth/second-factor/passkey/options",
        { headers: { "content-type": "application/json" }, method: "POST" },
      );
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
      const response = await fetch("/api/auth/second-factor/passkey/verify", {
        body: JSON.stringify({ response: assertion }),
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

  return (
    <div className="stack-lg">
      {error ? (
        <p className="notice-error" role="alert">
          {error}
        </p>
      ) : null}
      {passkeys ? (
        <div className="actions">
          <button
            className="button button-primary"
            disabled={busy}
            onClick={() => void usePasskey()}
            type="button"
          >
            <KeyRound aria-hidden size={18} />
            {busy ? "Waiting for passkey…" : "Use a passkey"}
          </button>
        </div>
      ) : null}
      {passkeys && (totp || recoveryCodes) ? <div className="divider" /> : null}
      {totp || recoveryCodes ? (
        <form className="auth-form" onSubmit={(event) => void submitCode(event)}>
          <div className="field">
            <label htmlFor="second-factor-code">
              {mode === "recovery" ? "Recovery code" : "Authenticator code"}
            </label>
            <input
              autoComplete="one-time-code"
              autoFocus={!passkeys}
              className="input code-input"
              id="second-factor-code"
              inputMode={mode === "recovery" ? "text" : "numeric"}
              onChange={(event) => setCode(event.target.value)}
              pattern={mode === "recovery" ? undefined : "[0-9 ]*"}
              placeholder={mode === "recovery" ? "xxxxx-xxxxx" : "123 456"}
              required
              value={code}
            />
          </div>
          <div className="actions">
            <button className="button button-primary" disabled={busy} type="submit">
              <LogIn aria-hidden size={18} />
              {busy ? "Verifying…" : "Sign in"}
            </button>
          </div>
          <div className="footer-links">
            {totp && recoveryCodes ? (
              <button
                className="footer-link-button"
                onClick={() => {
                  setMode(mode === "recovery" ? "code" : "recovery");
                  setCode("");
                  setError(undefined);
                }}
                type="button"
              >
                {mode === "recovery"
                  ? "Use my authenticator app instead"
                  : "Use a recovery code instead"}
              </button>
            ) : null}
            <a href="/login">Back to sign in</a>
          </div>
        </form>
      ) : (
        <div className="footer-links">
          <a href="/login">Back to sign in</a>
        </div>
      )}
    </div>
  );
}

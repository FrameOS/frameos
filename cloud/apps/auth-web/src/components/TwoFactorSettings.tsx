"use client";

import { startRegistration } from "@simplewebauthn/browser";
import {
  Copy,
  KeyRound,
  Plus,
  ShieldCheck,
  ShieldOff,
  Smartphone,
  Trash2,
} from "lucide-react";
import { useState } from "react";

export type TwoFactorStatusPayload = {
  enabled: boolean;
  has_password: boolean;
  passkeys: {
    backed_up: boolean;
    created_at: string;
    id: string;
    last_used_at: string | null;
    name: string;
  }[];
  recovery_codes_remaining: number;
  totp_enabled: boolean;
  totp_pending: boolean;
};

type TotpSetup = { otpauth_url: string; qr_svg: string; secret: string };

// Every action that weakens the account carries a proof: the password when
// the account has one, otherwise a current authenticator/recovery code. The
// form asks for it inline, right where the action is.
type ProofRequest = {
  label: string;
  run: (proof: Record<string, string>) => Promise<void>;
};

async function postJson(
  url: string,
  body: unknown,
  method = "POST",
): Promise<{ payload: Record<string, unknown> | undefined; response: Response }> {
  const response = await fetch(url, {
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: { "content-type": "application/json" },
    method,
  });
  const payload = (await response.json().catch(() => undefined)) as
    | Record<string, unknown>
    | undefined;
  return { payload, response };
}

function describeError(
  response: Response,
  payload: Record<string, unknown> | undefined,
) {
  const error = typeof payload?.error === "string" ? payload.error : "";
  switch (error) {
    case "invalid_password":
      return "The password is incorrect.";
    case "invalid_code":
      return "That code is not valid.";
    case "invalid_passkey":
    case "challenge_expired":
      return "The passkey could not be verified. Try again.";
    case "passkey_exists":
      return "That passkey is already registered.";
    case "too_many_passkeys":
      return "This account already has the maximum number of passkeys.";
    case "login_required":
      return "Your session expired. Reload the page and sign in again.";
    default:
      if (response.status === 429) {
        return "Too many attempts. Wait a few minutes and try again.";
      }
      return "Something went wrong. Try again in a moment.";
  }
}

function formatDate(value: string | null) {
  if (!value) {
    return "never";
  }
  return new Date(value).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function TwoFactorSettings({
  initial,
}: {
  initial: TwoFactorStatusPayload;
}) {
  const [status, setStatus] = useState(initial);
  const [error, setError] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [totpSetup, setTotpSetup] = useState<TotpSetup | undefined>();
  const [totpCode, setTotpCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | undefined>();
  const [proof, setProof] = useState<ProofRequest | undefined>();
  const [proofValue, setProofValue] = useState("");
  const [newPasskeyName, setNewPasskeyName] = useState("");
  const [renaming, setRenaming] = useState<{ id: string; name: string } | undefined>();

  async function refresh() {
    const { payload, response } = await postJson(
      "/api/account/two-factor",
      undefined,
      "GET",
    );
    if (response.ok && payload) {
      setStatus(payload as TwoFactorStatusPayload);
    }
  }

  function reset() {
    setError(undefined);
    setNotice(undefined);
  }

  // Runs `action`; on a proof-required failure the UI asks for the proof and
  // retries with it. Proof is collected once per click, never cached.
  function withProof(label: string, run: ProofRequest["run"]) {
    setProof({ label, run });
    setProofValue("");
    setError(undefined);
  }

  async function submitProof(event: React.FormEvent) {
    event.preventDefault();
    if (!proof) {
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await proof.run(
        status.has_password ? { password: proofValue } : { code: proofValue },
      );
      setProof(undefined);
      setProofValue("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Something went wrong.");
    }
    setBusy(false);
  }

  async function call(
    url: string,
    body: unknown,
    method = "POST",
  ): Promise<Record<string, unknown>> {
    const { payload, response } = await postJson(url, body, method);
    if (!response.ok) {
      throw new Error(describeError(response, payload));
    }
    return payload ?? {};
  }

  // -- Authenticator app ---------------------------------------------------

  async function startTotp() {
    reset();
    setBusy(true);
    try {
      const payload = await call("/api/account/two-factor/totp", {});
      setTotpSetup(payload as TotpSetup);
      setTotpCode("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Something went wrong.");
    }
    setBusy(false);
  }

  async function confirmTotp(event: React.FormEvent) {
    event.preventDefault();
    reset();
    setBusy(true);
    try {
      const payload = await call("/api/account/two-factor/totp/confirm", {
        code: totpCode,
      });
      setTotpSetup(undefined);
      setTotpCode("");
      if (Array.isArray(payload.recovery_codes)) {
        setRecoveryCodes(payload.recovery_codes as string[]);
      }
      setNotice("Authenticator app enabled.");
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Something went wrong.");
    }
    setBusy(false);
  }

  function removeTotp() {
    withProof("Remove the authenticator app", async (proofBody) => {
      await call("/api/account/two-factor/totp", proofBody, "DELETE");
      setNotice("Authenticator app removed.");
      await refresh();
    });
  }

  // -- Passkeys ------------------------------------------------------------

  async function addPasskey() {
    reset();
    setBusy(true);
    try {
      const optionsPayload = await call(
        "/api/account/two-factor/passkeys/options",
        {},
      );
      const options = optionsPayload.options as Parameters<
        typeof startRegistration
      >[0]["optionsJSON"];
      const attestation = await startRegistration({ optionsJSON: options });
      const payload = await call("/api/account/two-factor/passkeys", {
        name: newPasskeyName,
        response: attestation,
      });
      setNewPasskeyName("");
      if (Array.isArray(payload.recovery_codes)) {
        setRecoveryCodes(payload.recovery_codes as string[]);
      }
      setNotice("Passkey added.");
      await refresh();
    } catch (caught) {
      if (caught instanceof Error && caught.name === "NotAllowedError") {
        setError("Passkey prompt was cancelled.");
      } else if (caught instanceof Error && caught.name === "InvalidStateError") {
        setError("This passkey is already registered on this account.");
      } else {
        setError(
          caught instanceof Error
            ? caught.message
            : "Passkeys are not available on this device or browser.",
        );
      }
    }
    setBusy(false);
  }

  function removePasskey(id: string, name: string) {
    withProof(`Remove passkey “${name}”`, async (proofBody) => {
      await call(`/api/account/two-factor/passkeys/${id}`, proofBody, "DELETE");
      setNotice(`Passkey “${name}” removed.`);
      await refresh();
    });
  }

  async function savePasskeyName(event: React.FormEvent) {
    event.preventDefault();
    if (!renaming) {
      return;
    }
    reset();
    setBusy(true);
    try {
      await call(
        `/api/account/two-factor/passkeys/${renaming.id}`,
        { name: renaming.name },
        "PATCH",
      );
      setRenaming(undefined);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Something went wrong.");
    }
    setBusy(false);
  }

  // -- Recovery codes / disable -------------------------------------------

  function regenerateRecoveryCodes() {
    withProof("Generate new recovery codes", async (proofBody) => {
      const payload = await call(
        "/api/account/two-factor/recovery-codes",
        proofBody,
      );
      setRecoveryCodes(payload.recovery_codes as string[]);
      setNotice("New recovery codes generated. The old ones no longer work.");
      await refresh();
    });
  }

  function disableAll() {
    withProof("Turn off two-factor authentication", async (proofBody) => {
      await call("/api/account/two-factor/disable", proofBody);
      setRecoveryCodes(undefined);
      setNotice("Two-factor authentication is off.");
      await refresh();
    });
  }

  async function copyCodes() {
    if (!recoveryCodes) {
      return;
    }
    try {
      await navigator.clipboard.writeText(recoveryCodes.join("\n"));
      setNotice("Recovery codes copied.");
    } catch {
      setError("Could not copy — select the codes and copy them by hand.");
    }
  }

  return (
    <div className="stack-lg">
      <div className="inline-actions">
        <span className={`pill ${status.enabled ? "pill-ok" : ""}`}>
          {status.enabled ? (
            <>
              <ShieldCheck aria-hidden size={14} /> Two-factor on
            </>
          ) : (
            <>
              <ShieldOff aria-hidden size={14} /> Two-factor off
            </>
          )}
        </span>
      </div>

      {error ? (
        <p className="notice-error" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="notice" role="status">
          {notice}
        </p>
      ) : null}

      {recoveryCodes ? (
        <section className="card stack">
          <h3>Save your recovery codes</h3>
          <p className="copy">
            Each code signs you in once if you lose your authenticator or
            passkeys. They are shown only now — store them somewhere safe.
          </p>
          <pre className="device-code">{recoveryCodes.join("\n")}</pre>
          <div className="button-row">
            <button className="button" onClick={() => void copyCodes()} type="button">
              <Copy aria-hidden size={18} /> Copy
            </button>
            <button
              className="button button--subtle"
              onClick={() => setRecoveryCodes(undefined)}
              type="button"
            >
              I saved them
            </button>
          </div>
        </section>
      ) : null}

      {proof ? (
        <form className="card auth-form" onSubmit={(event) => void submitProof(event)}>
          <h3>{proof.label}</h3>
          <p className="copy">
            {status.has_password
              ? "Confirm your password to continue."
              : "Enter a current authenticator code or a recovery code to continue."}
          </p>
          <div className="field">
            <label htmlFor="two-factor-proof">
              {status.has_password ? "Password" : "Code"}
            </label>
            <input
              autoComplete={status.has_password ? "current-password" : "one-time-code"}
              autoFocus
              className="input"
              id="two-factor-proof"
              onChange={(event) => setProofValue(event.target.value)}
              required={status.has_password || status.totp_enabled}
              type={status.has_password ? "password" : "text"}
              value={proofValue}
            />
          </div>
          <div className="button-row">
            <button className="button button-danger" disabled={busy} type="submit">
              Continue
            </button>
            <button
              className="button button--subtle"
              onClick={() => setProof(undefined)}
              type="button"
            >
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      <section className="stack">
        <h3>
          <Smartphone aria-hidden size={18} /> Authenticator app
        </h3>
        {status.totp_enabled ? (
          <div className="button-row">
            <span className="pill pill-ok">Enabled</span>
            <button
              className="button button--subtle"
              disabled={busy}
              onClick={removeTotp}
              type="button"
            >
              <Trash2 aria-hidden size={16} /> Remove
            </button>
          </div>
        ) : totpSetup ? (
          <form className="auth-form" onSubmit={(event) => void confirmTotp(event)}>
            <p className="copy">
              Scan this with Google Authenticator, 1Password, Authy or any TOTP
              app, then enter the six-digit code it shows.
            </p>
            <div
              aria-label="QR code for the authenticator app"
              className="totp-qr"
              // Server-generated SVG from the qrcode library, never user input.
              dangerouslySetInnerHTML={{ __html: totpSetup.qr_svg }}
              role="img"
            />
            <p className="copy">
              Can&apos;t scan? Enter this key by hand:{" "}
              <code className="device-code">{totpSetup.secret}</code>
            </p>
            <div className="field">
              <label htmlFor="totp-confirm-code">Six-digit code</label>
              <input
                autoComplete="one-time-code"
                className="input code-input"
                id="totp-confirm-code"
                inputMode="numeric"
                onChange={(event) => setTotpCode(event.target.value)}
                placeholder="123 456"
                required
                value={totpCode}
              />
            </div>
            <div className="button-row">
              <button className="button button-primary" disabled={busy} type="submit">
                Turn on
              </button>
              <button
                className="button button--subtle"
                onClick={() => setTotpSetup(undefined)}
                type="button"
              >
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <div className="button-row">
            <p className="copy">
              Six-digit codes from an app on your phone, as a second step after
              your password.
            </p>
            <button
              className="button"
              disabled={busy}
              onClick={() => void startTotp()}
              type="button"
            >
              <Plus aria-hidden size={16} /> Set up
            </button>
          </div>
        )}
      </section>

      <section className="stack">
        <h3>
          <KeyRound aria-hidden size={18} /> Passkeys
        </h3>
        <p className="copy">
          Face ID, Touch ID, Windows Hello or a security key. A passkey works
          as a second step, and one with screen-lock verification can sign you
          in without a password at all.
        </p>
        {status.passkeys.length > 0 ? (
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Added</th>
                <th>Last used</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {status.passkeys.map((passkey) => (
                <tr key={passkey.id}>
                  <td>
                    {renaming?.id === passkey.id ? (
                      <form
                        className="inline-actions"
                        onSubmit={(event) => void savePasskeyName(event)}
                      >
                        <input
                          aria-label="Passkey name"
                          className="input"
                          maxLength={64}
                          onChange={(event) =>
                            setRenaming({ id: passkey.id, name: event.target.value })
                          }
                          value={renaming.name}
                        />
                        <button className="button button--small" type="submit">
                          Save
                        </button>
                        <button
                          className="button button--small button--subtle"
                          onClick={() => setRenaming(undefined)}
                          type="button"
                        >
                          Cancel
                        </button>
                      </form>
                    ) : (
                      <>
                        {passkey.name}
                        {passkey.backed_up ? (
                          <>
                            {" "}
                            <span className="pill">synced</span>
                          </>
                        ) : null}
                      </>
                    )}
                  </td>
                  <td>{formatDate(passkey.created_at)}</td>
                  <td>{formatDate(passkey.last_used_at)}</td>
                  <td>
                    <div className="inline-actions">
                      <button
                        className="button button--small button--subtle"
                        onClick={() =>
                          setRenaming({ id: passkey.id, name: passkey.name })
                        }
                        type="button"
                      >
                        Rename
                      </button>
                      <button
                        className="button button--small button--subtle"
                        disabled={busy}
                        onClick={() => removePasskey(passkey.id, passkey.name)}
                        type="button"
                      >
                        <Trash2 aria-hidden size={14} /> Remove
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
        <div className="device-code-form">
          <div className="field">
            <label htmlFor="new-passkey-name">Name for the new passkey</label>
            <input
              className="input"
              id="new-passkey-name"
              maxLength={64}
              onChange={(event) => setNewPasskeyName(event.target.value)}
              placeholder="e.g. MacBook Touch ID"
              value={newPasskeyName}
            />
          </div>
          <button
            className="button"
            disabled={busy}
            onClick={() => void addPasskey()}
            type="button"
          >
            <Plus aria-hidden size={16} /> Add a passkey
          </button>
        </div>
      </section>

      {status.enabled ? (
        <section className="stack">
          <h3>Recovery codes</h3>
          <p className="copy">
            {status.recovery_codes_remaining} unused recovery{" "}
            {status.recovery_codes_remaining === 1 ? "code" : "codes"} left.
            Each one signs you in once when your authenticator or passkeys are
            out of reach.
          </p>
          <div className="button-row">
            <button
              className="button"
              disabled={busy}
              onClick={regenerateRecoveryCodes}
              type="button"
            >
              Generate new codes
            </button>
            <button
              className="button button--subtle"
              disabled={busy}
              onClick={disableAll}
              type="button"
            >
              <ShieldOff aria-hidden size={16} /> Turn off two-factor
            </button>
          </div>
        </section>
      ) : null}
    </div>
  );
}

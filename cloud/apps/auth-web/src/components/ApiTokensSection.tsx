"use client";

import { KeyRound, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { CopyUrlField } from "./CopyUrlField";

export type ApiTokenPayload = {
  access: "full" | "read_only";
  created_at: string;
  expires_at: string | null;
  id: string;
  last_used_at: string | null;
  name: string;
  token_hint: string;
};

// The personal API tokens list on /account/developer: create (the secret
// shows exactly once, with a copy button), revoke, and what each token has
// been up to. Creation needs a recent sign-in; the page decides whether to
// render the form or the re-authentication link.

function formatDate(value: string | null) {
  if (!value) {
    return "never";
  }
  return new Date(value).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function describeError(status: number, error: string | undefined) {
  switch (error) {
    case "invalid_name":
      return "Give the token a name (up to 64 characters).";
    case "token_quota_exceeded":
      return "This account already has the maximum number of tokens. Revoke one first.";
    case "reauth_required":
      return "Confirm your credentials again before creating a token.";
    case "login_required":
      return "Your session expired. Reload the page and sign in again.";
    default:
      return status === 429
        ? "Too many attempts. Wait a few minutes and try again."
        : "Something went wrong. Try again in a moment.";
  }
}

export function ApiTokensSection({
  canCreate,
  initialTokens,
  maxTokens,
  reauthHref,
}: {
  canCreate: boolean;
  initialTokens: ApiTokenPayload[];
  maxTokens: number;
  reauthHref: string;
}) {
  const [tokens, setTokens] = useState(initialTokens);
  const [name, setName] = useState("");
  const [access, setAccess] = useState<"full" | "read_only">("full");
  const [expiresInDays, setExpiresInDays] = useState<string>("90");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [fresh, setFresh] = useState<
    { id: string; name: string; token: string } | undefined
  >();

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch("/api/account/api-tokens", {
        body: JSON.stringify({
          access,
          name,
          expires_in_days: Number(expiresInDays),
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json().catch(() => undefined)) as
        | { api_token?: ApiTokenPayload; error?: string; token?: string }
        | undefined;
      const created = payload?.api_token;
      if (!response.ok || !payload?.token || !created) {
        setError(describeError(response.status, payload?.error));
        return;
      }
      setTokens((current) => [...current, created]);
      setFresh({ id: created.id, name, token: payload.token });
      setName("");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(token: ApiTokenPayload) {
    if (
      !window.confirm(
        `Revoke the token "${token.name}"? Anything using it stops working immediately.`,
      )
    ) {
      return;
    }
    setError(undefined);
    const response = await fetch(`/api/account/api-tokens/${token.id}`, {
      method: "DELETE",
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => undefined)) as
        | { error?: string }
        | undefined;
      setError(describeError(response.status, payload?.error));
      return;
    }
    setTokens((current) => current.filter((entry) => entry.id !== token.id));
    if (fresh?.id === token.id) {
      setFresh(undefined);
    }
  }

  return (
    <div className="stack">
      {fresh ? (
        <div className="notice" role="status">
          <p>
            <strong>{fresh.name}</strong> is ready. Copy it now — it is shown
            only once.
          </p>
          <CopyUrlField value={fresh.token} />
        </div>
      ) : null}

      {tokens.length === 0 ? (
        <p className="copy">No API tokens yet.</p>
      ) : (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Token</th>
                <th>Access</th>
                <th>Last used</th>
                <th>Expires</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {tokens.map((token) => (
                <tr key={token.id}>
                  <td>
                    <KeyRound aria-hidden size={14} /> {token.name}
                  </td>
                  <td>
                    <code>{token.token_hint}…</code>
                  </td>
                  <td>{token.access === "read_only" ? "Read-only" : "Full"}</td>
                  <td>{formatDate(token.last_used_at)}</td>
                  <td>{token.expires_at ? formatDate(token.expires_at) : "never"}</td>
                  <td>
                    <button
                      className="button button-danger button--small"
                      onClick={() => void revoke(token)}
                      type="button"
                    >
                      <Trash2 aria-hidden size={14} />
                      Revoke
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {canCreate ? (
        <form
          className="api-token-form"
          onSubmit={(event) => void create(event)}
        >
          <div className="field api-token-form__name">
            <label htmlFor="api-token-name">Name</label>
            <input
              className="input"
              id="api-token-name"
              maxLength={64}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Claude Code on my laptop"
              required
              value={name}
            />
          </div>
          <div className="field">
            <label htmlFor="api-token-access">Access</label>
            <select
              className="input"
              id="api-token-access"
              onChange={(event) =>
                setAccess(event.target.value as "full" | "read_only")
              }
              value={access}
            >
              <option value="full">Full access</option>
              <option value="read_only">Read-only</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="api-token-expiry">Expires</label>
            <select
              className="input"
              id="api-token-expiry"
              onChange={(event) => setExpiresInDays(event.target.value)}
              value={expiresInDays}
            >
              <option value="7">In 7 days</option>
              <option value="30">In 30 days</option>
              <option value="90">In 90 days</option>
              <option value="365">In a year</option>
            </select>
          </div>
          <button
            className="button button-primary"
            disabled={busy || tokens.length >= maxTokens}
            type="submit"
          >
            <Plus aria-hidden size={16} />
            Create token
          </button>
          <p className="copy api-token-form__hint">
            {access === "read_only"
              ? "Read-only tokens can look at everything but never change it."
              : "Full tokens can do everything the account can, except revoke frames or approve device links."}{" "}
            {tokens.length} of {maxTokens} tokens used.
          </p>
        </form>
      ) : (
        <p className="copy">
          Creating a token turns this session into a durable credential, so
          it asks you to <a href={reauthHref}>confirm your credentials</a>{" "}
          first.
        </p>
      )}

      {error ? (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

"use client";

import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import {
  describeSettingsError,
  describeSshPublicKey,
  sshKeysFrom,
  type SshKeyEntry,
} from "../lib/account-settings-form";

// The account's SSH public keys on /account/settings — what the SD card
// builder installs on new Linux frames. Every change is saved on the spot
// (the list is one settings group, `ssh_keys`, posted wholesale) and the
// list re-renders from what the server kept: it validates each line and
// drops anything that is not an OpenSSH public key, so what you see is what
// the builder will write.

export function AccountSshKeys({ initialKeys }: { initialKeys: SshKeyEntry[] }) {
  const [keys, setKeys] = useState(initialKeys);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [publicKey, setPublicKey] = useState("");
  const [useForNewFrames, setUseForNewFrames] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function persist(next: SshKeyEntry[]): Promise<boolean> {
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch("/api/settings", {
        body: JSON.stringify({ ssh_keys: { keys: next } }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json().catch(() => undefined)) as
        | (Record<string, unknown> & { error?: string })
        | undefined;
      if (!response.ok) {
        setError(describeSettingsError(response.status, payload?.error));
        return false;
      }
      setKeys(sshKeysFrom(payload));
      return true;
    } catch {
      setError(describeSettingsError(0, undefined));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function add(event: React.FormEvent) {
    event.preventDefault();
    const line = publicKey.trim().replace(/\s+/g, " ");
    if (!line) {
      setError("Paste the public key first.");
      return;
    }
    const entry: SshKeyEntry = {
      id: crypto.randomUUID(),
      name: name.trim(),
      public: line,
      use_for_new_frames: useForNewFrames,
    };
    if (await persist([...keys, entry])) {
      setAdding(false);
      setName("");
      setPublicKey("");
      setUseForNewFrames(true);
    }
  }

  async function remove(key: SshKeyEntry) {
    const label = key.name || describeSshPublicKey(key.public);
    if (
      !window.confirm(
        `Remove the SSH key "${label}"? Frames it is already installed on keep it.`,
      )
    ) {
      return;
    }
    await persist(keys.filter((entry) => entry.id !== key.id));
  }

  async function setDefault(key: SshKeyEntry, value: boolean) {
    await persist(
      keys.map((entry) =>
        entry.id === key.id ? { ...entry, use_for_new_frames: value } : entry,
      ),
    );
  }

  return (
    <div className="stack">
      {keys.length === 0 ? (
        <p className="copy">No SSH keys yet. Add one to be able to log in to new frames over SSH.</p>
      ) : (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Key</th>
                <th>New frames</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {keys.map((key) => {
                const label = key.name || "Unnamed key";
                return (
                  <tr key={key.id}>
                    <td>
                      <strong>{label}</strong>
                    </td>
                    <td>
                      <code>{describeSshPublicKey(key.public)}</code>
                    </td>
                    <td>
                      <label className="account-settings__check">
                        <input
                          aria-label={`Install ${label} on new frames by default`}
                          checked={key.use_for_new_frames}
                          disabled={busy}
                          onChange={(event) => void setDefault(key, event.target.checked)}
                          type="checkbox"
                        />
                        <span>by default</span>
                      </label>
                    </td>
                    <td className="cell-nowrap">
                      <button
                        aria-label={`Remove ${label}`}
                        className="button button--small button--subtle"
                        disabled={busy}
                        onClick={() => void remove(key)}
                        title="Remove this key"
                        type="button"
                      >
                        <Trash2 aria-hidden="true" size={16} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {error ? (
        <p className="notice-error" role="alert">
          {error}
        </p>
      ) : null}

      {adding ? (
        <form className="stack" onSubmit={(event) => void add(event)}>
          <div className="field">
            <label htmlFor="ssh-key-name">Key name</label>
            <input
              autoFocus
              className="input"
              id="ssh-key-name"
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Marius' laptop"
              value={name}
            />
          </div>
          <div className="field">
            <label htmlFor="ssh-key-public">Public key</label>
            <textarea
              className="input account-settings__textarea"
              id="ssh-key-public"
              onChange={(event) => setPublicKey(event.target.value)}
              placeholder="ssh-ed25519 AAAA… you@laptop"
              rows={3}
              spellCheck={false}
              value={publicKey}
            />
          </div>
          <label className="account-settings__check">
            <input
              checked={useForNewFrames}
              onChange={(event) => setUseForNewFrames(event.target.checked)}
              type="checkbox"
            />
            <span>Install on new frames by default</span>
          </label>
          <div className="button-row">
            <button className="button button-primary" disabled={busy} type="submit">
              {busy ? "Saving…" : "Add key"}
            </button>
            <button
              className="button"
              disabled={busy}
              onClick={() => {
                setAdding(false);
                setError(undefined);
              }}
              type="button"
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div>
          <button
            className="button button--small"
            disabled={busy}
            onClick={() => setAdding(true)}
            type="button"
          >
            <Plus aria-hidden="true" size={16} />
            Add SSH key
          </button>
        </div>
      )}
    </div>
  );
}

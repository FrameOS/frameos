"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export type GroupOption = { id: string; name: string };

// Re-pointing one account at another reporting group. Mutable, instant, and
// free of accounting consequence: no posting moves and no balance changes,
// every report simply buckets differently from the next render. If an
// *amount* is in the wrong place, that is a reclassification on the Journal
// page instead — the distinction is why both exist.
export function LedgerAccountGroupSelect({
  groupId,
  groups,
  ledgerAccountId,
}: {
  groupId: string | null;
  groups: GroupOption[];
  ledgerAccountId: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function assign(next: string) {
    setBusy(true);
    setError(null);
    const response = await fetch("/api/admin/billing/groups", {
      body: JSON.stringify({
        action: "assign",
        groupId: next || null,
        ledgerAccountId,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const payload = await response.json().catch(() => ({}));
    setBusy(false);
    if (response.ok) {
      router.refresh();
    } else {
      setError(payload.detail ?? `Failed: ${payload.error ?? response.status}`);
    }
  }

  return (
    <>
      <select
        aria-label="Reporting group"
        className="input"
        disabled={busy}
        onChange={(event) => void assign(event.target.value)}
        value={groupId ?? ""}
      >
        <option value="">Ungrouped</option>
        {groups.map((group) => (
          <option key={group.id} value={group.id}>
            {group.name}
          </option>
        ))}
      </select>
      {error ? <span className="risk-badge">{error}</span> : null}
    </>
  );
}

export function CreateLedgerGroupForm() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    const response = await fetch("/api/admin/billing/groups", {
      body: JSON.stringify({ action: "create", code, name }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const payload = await response.json().catch(() => ({}));
    setBusy(false);
    if (response.ok) {
      setCode("");
      setName("");
      setMessage("Created.");
      router.refresh();
    } else {
      setMessage(payload.detail ?? `Failed: ${payload.error ?? response.status}`);
    }
  }

  return (
    <form className="inline-actions" onSubmit={(event) => void submit(event)}>
      <input
        aria-label="Group code"
        className="input"
        onChange={(event) => setCode(event.target.value)}
        placeholder="platform_revenue"
        value={code}
      />
      <input
        aria-label="Group name"
        className="input"
        onChange={(event) => setName(event.target.value)}
        placeholder="Platform revenue"
        value={name}
      />
      <button className="button" disabled={busy} type="submit">
        {busy ? "Creating…" : "Add group"}
      </button>
      {message ? <span className="pill">{message}</span> : null}
    </form>
  );
}

"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

// Reversing an entry, from the row it is on. There is no "edit" and there
// never will be: a wrong entry is mirrored leg for leg and, if something
// correct belongs in its place, posted fresh beside it. Both halves stay in
// the journal, which is what makes the correction auditable rather than
// invisible.
export function JournalEntryActions({
  accountId,
  entryId,
  reversedByEntryId,
  reversesEntryId,
}: {
  accountId: string | null;
  entryId: string;
  reversedByEntryId: string | null;
  reversesEntryId: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (reversedByEntryId) {
    return <span className="pill">reversed</span>;
  }
  if (reversesEntryId) {
    return <span className="pill">is a reversal</span>;
  }

  async function reverse() {
    const reason = window.prompt(
      "Why is this entry being reversed? The reason goes into the books.",
    );
    if (!reason?.trim()) {
      return;
    }
    setBusy(true);
    setError(null);
    const response = await fetch("/api/admin/billing/journal", {
      body: JSON.stringify({
        accountId,
        action: "reverse",
        entryId,
        reason: reason.trim(),
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
    <div className="inline-actions">
      <button
        className="button button--small button-danger"
        disabled={busy}
        onClick={() => void reverse()}
        type="button"
      >
        {busy ? "Reversing…" : "Reverse"}
      </button>
      {error ? <span className="risk-badge">{error}</span> : null}
    </div>
  );
}

"use client";

import { Ban, Undo2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

// Account-level store publish ban: existing scenes stay (pull those
// separately), but every new publish from the account is rejected.
export function AdminPublisherBanButton({
  accountId,
  banned,
  ownerLabel,
}: {
  accountId: string;
  banned: boolean;
  ownerLabel: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  async function toggle() {
    let reason: string | null = null;
    if (!banned) {
      reason = window.prompt(
        `Ban ${ownerLabel} from publishing to the store? Existing scenes stay until pulled.\n\nReason:`,
      );
      if (reason === null) {
        return;
      }
    }
    setBusy(true);
    setError(false);
    const response = await fetch(`/api/admin/publishers/${accountId}`, {
      body: JSON.stringify(
        banned ? { store_banned: false } : { reason, store_banned: true },
      ),
      headers: { "content-type": "application/json" },
      method: "PATCH",
    });
    if (response.ok) {
      router.refresh();
    } else {
      setError(true);
    }
    setBusy(false);
  }

  return (
    <>
      <button
        className={banned ? "button" : "button button-danger"}
        disabled={busy}
        onClick={() => void toggle()}
        type="button"
      >
        {banned ? (
          <Undo2 aria-hidden size={16} />
        ) : (
          <Ban aria-hidden size={16} />
        )}
        {banned ? "Unban publisher" : "Ban publisher"}
      </button>
      {error ? <span className="pill pill-warning">Failed</span> : null}
    </>
  );
}

"use client";

import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

// "Sync plans" on /admin/billing/payments: makes the catalog's self-serve
// plans buyable in the payment provider's current mode.
export function BillingPlanSyncButton({ disabled }: { disabled: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  async function sync() {
    setBusy(true);
    setError(undefined);
    setMessage(undefined);
    try {
      const response = await fetch("/api/admin/billing/provider", {
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const body = (await response.json().catch(() => ({}))) as {
        detail?: string;
        plans?: { created: boolean }[];
      };
      if (!response.ok) {
        setError(body.detail ?? "Could not sync the plans. Try again in a moment.");
        return;
      }
      const created = (body.plans ?? []).filter((plan) => plan.created).length;
      setMessage(created > 0 ? `Created ${created} products.` : "Everything was already in place.");
      router.refresh();
    } catch {
      setError("Could not sync the plans. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        className="button button--small"
        disabled={busy || disabled}
        onClick={() => void sync()}
        type="button"
      >
        <RefreshCw aria-hidden size={16} />
        {busy ? "Syncing…" : "Sync plans"}
      </button>
      {message ? <span className="pill">{message}</span> : null}
      {error ? (
        <span className="pill pill-warning" role="alert">
          {error}
        </span>
      ) : null}
    </>
  );
}

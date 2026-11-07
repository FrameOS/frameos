"use client";

import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  isReauthRequired,
  redirectToReauthIfRequired,
  takePendingReauthAction,
} from "../lib/reauth-client";

const resumeAction = "billing-sync-plans";

// "Sync plans" on /admin/billing/customers: writes the catalog's self-serve
// stops as billing_plans rows, so the operator plan form can move an account
// onto one. The route is behind sudo mode, so a session that has not proved
// itself lately goes through /login/reauth and the sync runs on the way back.
export function BillingPlanSyncButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  // Back from /login/reauth: finish the sync that was asked for.
  useEffect(() => {
    if (takePendingReauthAction(resumeAction)) {
      void sync({ resumed: true });
    }
  }, []);

  async function sync({ resumed = false } = {}) {
    setBusy(true);
    setError(undefined);
    setMessage(undefined);
    try {
      const response = await fetch("/api/admin/billing/plans", {
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const body = (await response.json().catch(() => ({}))) as {
        detail?: string;
        error?: string;
        plans?: string[];
      };
      if (!response.ok) {
        // A second refusal straight after confirming is an error to show,
        // not a loop to go round again.
        if (
          !(resumed && isReauthRequired(response, body)) &&
          redirectToReauthIfRequired(response, body, resumeAction)
        ) {
          return;
        }
        setError(body.detail ?? "Could not sync the plans. Try again in a moment.");
        return;
      }
      setMessage(`${(body.plans ?? []).length} plans in place.`);
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
        disabled={busy}
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

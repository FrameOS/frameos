"use client";

import { CheckCircle2, Unplug } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  isReauthRequired,
  redirectToReauthIfRequired,
  takePendingReauthAction,
} from "../lib/reauth-client";

// Confirm (pending → active) or revoke a cloud-managed frame. Revoking cuts
// the link: the device sees 401 on its next connect and demotes itself to
// standalone (it keeps rendering; re-enrolling needs a new claim code).
export function FrameRowActions({
  frameId,
  status,
}: {
  frameId: string;
  status: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const revokePath = `/api/frames/${frameId}/revoke`;

  // Back from /login/reauth: the user already confirmed the revoke before
  // being sent away, so finish it without asking again.
  useEffect(() => {
    if (takePendingReauthAction(revokePath)) {
      void post(revokePath, undefined, { resumed: true });
    }
  }, [revokePath]);

  async function post(
    path: string,
    confirmText?: string,
    { resumed = false } = {},
  ) {
    if (!resumed && confirmText && !window.confirm(confirmText)) {
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch(path, {
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        // Revoking needs a recent credential check; /login/reauth brings
        // the user straight back here and the effect above resumes. A
        // resumed call that is still refused (Cancel on the reauth page)
        // stops quietly instead of bouncing back to the reauth page.
        if (resumed && isReauthRequired(response, data)) {
          return;
        }
        if (redirectToReauthIfRequired(response, data, path)) {
          return;
        }
        setError(data.error ?? `error_${response.status}`);
        return;
      }
      router.refresh();
    } catch {
      setError("network_error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-actions">
      {status === "pending" ? (
        <button
          className="button button--small"
          disabled={busy}
          onClick={() => void post(`/api/frames/${frameId}/confirm`)}
          type="button"
        >
          <CheckCircle2 aria-hidden size={16} />
          Confirm
        </button>
      ) : null}
      {status !== "revoked" ? (
        <button
          className="button button--subtle button--small"
          disabled={busy}
          onClick={() =>
            void post(
              `/api/frames/${frameId}/revoke`,
              "Revoke this frame? It will disconnect from the cloud and keep showing its current scenes. Re-enrolling needs a new claim code.",
            )
          }
          type="button"
        >
          <Unplug aria-hidden size={16} />
          Revoke
        </button>
      ) : null}
      {error ? <span className="pill pill--error">{error}</span> : null}
    </span>
  );
}

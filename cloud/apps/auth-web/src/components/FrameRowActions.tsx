"use client";

import { CheckCircle2, Unplug } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

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

  async function post(path: string, confirmText?: string) {
    if (confirmText && !window.confirm(confirmText)) {
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

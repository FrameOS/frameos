"use client";

import { Unplug } from "lucide-react";
import { useEffect, useState } from "react";
import {
  isReauthRequired,
  redirectToReauthIfRequired,
  takePendingReauthAction,
} from "../lib/reauth-client";

export function RevokeLinkedClientButton({ linkedClientId }: { linkedClientId: string }) {
  const [status, setStatus] = useState<"idle" | "revoking" | "revoked" | "error">("idle");

  const resumeAction = `revoke-install:${linkedClientId}`;

  // Back from /login/reauth: finish the revoke the user already started.
  useEffect(() => {
    if (takePendingReauthAction(resumeAction)) {
      void revoke({ resumed: true });
    }
  }, [resumeAction]);

  async function revoke({ resumed = false } = {}) {
    setStatus("revoking");
    const response = await fetch("/api/device/revoke", {
      body: JSON.stringify({ linked_client_id: linkedClientId }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    if (!response.ok) {
      const payload = (await response.json().catch(() => undefined)) as
        | { error?: string }
        | undefined;
      // A resumed call that is still refused (Cancel on the reauth page)
      // shows the error instead of bouncing back to /login/reauth.
      if (
        !(resumed && isReauthRequired(response, payload)) &&
        redirectToReauthIfRequired(response, payload, resumeAction)
      ) {
        return;
      }
    }
    setStatus(response.ok ? "revoked" : "error");
  }

  return (
    <button className="button button--small" disabled={status !== "idle"} onClick={() => void revoke()} type="button">
      <Unplug aria-hidden size={18} />
      {status === "revoked" ? "Revoked" : "Revoke"}
    </button>
  );
}

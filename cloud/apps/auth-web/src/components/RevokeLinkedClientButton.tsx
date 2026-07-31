"use client";

import { Unplug } from "lucide-react";
import { useState } from "react";

export function RevokeLinkedClientButton({ linkedClientId }: { linkedClientId: string }) {
  const [status, setStatus] = useState<"idle" | "revoking" | "revoked" | "error">("idle");

  async function revoke() {
    setStatus("revoking");
    const response = await fetch("/api/device/revoke", {
      body: JSON.stringify({ linked_client_id: linkedClientId }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    setStatus(response.ok ? "revoked" : "error");
  }

  return (
    <button className="button button--small" disabled={status !== "idle"} onClick={() => void revoke()} type="button">
      <Unplug aria-hidden size={18} />
      {status === "revoked" ? "Revoked" : "Revoke"}
    </button>
  );
}

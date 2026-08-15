"use client";

import { BadgeCheck, BadgeMinus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

// Verified-publisher trust mark: surfaced as a badge in the store and as a
// trust signal in the AI chat's store search.
export function AdminPublisherVerifyButton({
  accountId,
  ownerLabel,
  verified,
}: {
  accountId: string;
  ownerLabel: string;
  verified: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  async function toggle() {
    if (
      verified &&
      !window.confirm(`Remove the verified-publisher mark from ${ownerLabel}?`)
    ) {
      return;
    }
    setBusy(true);
    setError(false);
    const response = await fetch(`/api/admin/publishers/${accountId}`, {
      body: JSON.stringify({ verified_publisher: !verified }),
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
        className="button"
        disabled={busy}
        onClick={() => void toggle()}
        type="button"
      >
        {verified ? (
          <BadgeMinus aria-hidden size={16} />
        ) : (
          <BadgeCheck aria-hidden size={16} />
        )}
        {verified ? "Unverify publisher" : "Verify publisher"}
      </button>
      {error ? <span className="pill pill-warning">Failed</span> : null}
    </>
  );
}

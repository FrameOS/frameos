"use client";

import { Check } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function ResolveReportButton({ reportId }: { reportId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  async function resolve() {
    setBusy(true);
    setError(false);
    const response = await fetch(`/api/admin/reports/${reportId}`, {
      body: JSON.stringify({ status: "resolved" }),
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
        onClick={() => void resolve()}
        type="button"
      >
        <Check aria-hidden size={16} />
        Resolve
      </button>
      {error ? <span className="pill pill-warning">Failed</span> : null}
    </>
  );
}

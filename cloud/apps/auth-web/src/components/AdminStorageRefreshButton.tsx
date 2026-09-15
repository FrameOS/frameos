"use client";

import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

// "Measure again" on /admin/storage. The request waits for the sweep — an
// admin who asked for fresh numbers wants the fresh numbers, not a promise
// that they are coming — and the page reloads onto them. A sweep already
// running is joined rather than started twice.
export function AdminStorageRefreshButton({ running }: { running: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function refresh() {
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch("/api/admin/storage/refresh", {
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      if (!response.ok) {
        setError(
          response.status === 429
            ? "Too many refreshes. Wait a few minutes."
            : "Could not measure storage. Try again in a moment.",
        );
        return;
      }
      router.refresh();
    } catch {
      setError("Could not measure storage. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  }

  // No wrapper: the button is a flex item of the filter bar it sits in, and a
  // box of its own there would be a second row's worth of nothing.
  return (
    <>
      <button
        className="button button--small"
        disabled={busy}
        onClick={() => void refresh()}
        type="button"
      >
        <RefreshCw aria-hidden size={16} />
        {busy || running ? "Measuring…" : "Measure again"}
      </button>
      {error ? (
        <span className="pill pill-warning" role="alert">
          {error}
        </span>
      ) : null}
    </>
  );
}

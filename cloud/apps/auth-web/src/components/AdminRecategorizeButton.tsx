"use client";

import { Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

// Superadmin bulk action: run the publish-time classifier over the store.
// "Categorize missing" fills gaps; "Redo all" reclassifies every active
// scene (owner tags are only filled when empty, never replaced).
export function AdminRecategorizeButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  async function run(mode: "missing" | "all") {
    if (
      mode === "all" &&
      !window.confirm(
        "Reclassify every active scene? Existing categories are overwritten (owner tags are kept).",
      )
    ) {
      return;
    }
    setBusy(true);
    setResult(null);
    const response = await fetch("/api/admin/scenes/recategorize", {
      body: JSON.stringify({ mode }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const payload = await response.json().catch(() => ({}));
    setBusy(false);
    if (response.ok) {
      setResult(
        `Categorized ${payload.updated?.length ?? 0} of ${payload.scanned ?? 0} scene(s)` +
          (payload.failed?.length ? `, ${payload.failed.length} failed` : ""),
      );
      router.refresh();
    } else {
      setResult(
        payload.error === "classification_unavailable"
          ? "OPENAI_API_KEY is not configured on the server."
          : `Failed: ${payload.error ?? response.status}`,
      );
    }
  }

  return (
    <div className="inline-actions">
      <button
        className="button"
        disabled={busy}
        onClick={() => void run("missing")}
        type="button"
      >
        <Sparkles aria-hidden size={16} />
        {busy ? "Categorizing…" : "Categorize missing"}
      </button>
      <button
        className="button button--subtle"
        disabled={busy}
        onClick={() => void run("all")}
        type="button"
      >
        Redo all
      </button>
      {result ? <span className="pill">{result}</span> : null}
    </div>
  );
}

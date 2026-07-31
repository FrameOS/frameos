"use client";

import { ShieldAlert, ShieldCheck, Star, StarOff } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

// Superadmin moderation controls for one scene: pull with a reason (the
// kill switch), restore, feature/unfeature.
export function AdminSceneActions({
  featured,
  name,
  sceneId,
  status,
}: {
  featured: boolean;
  name: string;
  sceneId: string;
  status: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  async function patch(body: Record<string, unknown>) {
    setBusy(true);
    setError(false);
    const response = await fetch(`/api/admin/scenes/${sceneId}`, {
      body: JSON.stringify(body),
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

  async function pull() {
    const reason = window.prompt(
      `Pull "${name}" from the store? It disappears everywhere and downloads return 410.\n\nReason (shown to the owner):`,
    );
    if (reason === null) {
      return;
    }
    await patch({ pulled_reason: reason, status: "pulled" });
  }

  return (
    <div className="inline-actions">
      {status === "pulled" ? (
        <button
          className="button"
          disabled={busy}
          onClick={() => void patch({ status: "active" })}
          type="button"
        >
          <ShieldCheck aria-hidden size={16} />
          Restore
        </button>
      ) : (
        <>
          <button
            className="button"
            disabled={busy}
            onClick={() => void patch({ featured: !featured })}
            type="button"
          >
            {featured ? (
              <StarOff aria-hidden size={16} />
            ) : (
              <Star aria-hidden size={16} />
            )}
            {featured ? "Unfeature" : "Feature"}
          </button>
          <button
            className="button button-danger"
            disabled={busy}
            onClick={() => void pull()}
            type="button"
          >
            <ShieldAlert aria-hidden size={16} />
            Pull
          </button>
        </>
      )}
      {error ? <span className="pill pill-warning">Failed</span> : null}
    </div>
  );
}

"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { storeCategories } from "../lib/categories";

// Superadmin per-scene category override, saved through the admin scene
// PATCH (curation is a store concern, not owner speech).
export function AdminSceneCategorySelect({
  category,
  sceneId,
}: {
  category: string | null;
  sceneId: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  async function save(next: string) {
    setBusy(true);
    setError(false);
    const response = await fetch(`/api/admin/scenes/${sceneId}`, {
      body: JSON.stringify({ category: next || null }),
      headers: { "content-type": "application/json" },
      method: "PATCH",
    });
    setBusy(false);
    if (response.ok) {
      router.refresh();
    } else {
      setError(true);
    }
  }

  return (
    <span className="inline-actions">
      <select
        aria-label="Category"
        className="input"
        disabled={busy}
        onChange={(event) => void save(event.target.value)}
        value={category ?? ""}
      >
        <option value="">(none)</option>
        {storeCategories.map((entry) => (
          <option key={entry.slug} value={entry.slug}>
            {entry.title}
          </option>
        ))}
      </select>
      {error ? <span className="pill pill-warning">Failed</span> : null}
    </span>
  );
}

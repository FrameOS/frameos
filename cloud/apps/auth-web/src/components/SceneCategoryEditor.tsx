"use client";

import { Check, Pencil, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { storeCategories } from "../lib/categories";

// Owner editing of a scene's category: one slug from the fixed store
// taxonomy (or none), saved through the account scene PATCH. New publishes
// are categorized automatically; this is the manual override.
export function SceneCategoryEditor({
  category,
  sceneId,
}: {
  category: string | null;
  sceneId: string;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(category ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    const response = await fetch(`/api/account/scenes/${sceneId}`, {
      body: JSON.stringify({ category: value || null }),
      headers: { "content-type": "application/json" },
      method: "PATCH",
    });
    setBusy(false);
    if (response.ok) {
      setEditing(false);
      router.refresh();
      return;
    }
    const payload = await response.json().catch(() => ({}));
    setError(`Saving failed: ${payload.error ?? response.status}`);
  }

  if (!editing) {
    return (
      <button
        className="tag-edit-button"
        onClick={() => {
          setValue(category ?? "");
          setEditing(true);
        }}
        title="Edit category"
        type="button"
      >
        <Pencil aria-hidden size={14} />
        {category === null ? "Set category" : "Edit category"}
      </button>
    );
  }

  return (
    <span className="tag-editor">
      <select
        aria-label="Category"
        className="input"
        onChange={(event) => setValue(event.target.value)}
        value={value}
      >
        <option value="">(none)</option>
        {storeCategories.map((entry) => (
          <option key={entry.slug} value={entry.slug}>
            {entry.title}
          </option>
        ))}
      </select>
      <button
        className="button"
        disabled={busy}
        onClick={() => void save()}
        type="button"
      >
        <Check aria-hidden size={14} />
        Save
      </button>
      <button
        className="button button--subtle"
        onClick={() => {
          setEditing(false);
          setError(null);
        }}
        type="button"
      >
        <X aria-hidden size={14} />
      </button>
      {error ? <span className="pill pill-warning">{error}</span> : null}
    </span>
  );
}

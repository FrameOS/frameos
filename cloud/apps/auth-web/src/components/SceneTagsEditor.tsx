"use client";

import { Check, Pencil, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

// Owner editing of a scene's tags: comma/space separated slugs, saved
// through the account scene PATCH (validated + moderated server-side).
export function SceneTagsEditor({
  sceneId,
  tags,
}: {
  sceneId: string;
  tags: string[];
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(tags.join(", "));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const nextTags = value
      .split(/[\s,]+/)
      .map((tag) => tag.trim().toLowerCase())
      .filter(Boolean);
    setBusy(true);
    setError(null);
    const response = await fetch(`/api/account/scenes/${sceneId}`, {
      body: JSON.stringify({ tags: nextTags }),
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
    setError(
      payload.error === "invalid_tags"
        ? "Up to 5 tags; lowercase letters, digits, dashes, max 24 characters each."
        : `Saving failed: ${payload.error ?? response.status}`,
    );
  }

  if (!editing) {
    return (
      <button
        className="tag-edit-button"
        onClick={() => {
          setValue(tags.join(", "));
          setEditing(true);
        }}
        title="Edit tags"
        type="button"
      >
        <Pencil aria-hidden size={14} />
        {tags.length === 0 ? "Add tags" : "Edit tags"}
      </button>
    );
  }

  return (
    <span className="tag-editor">
      <input
        aria-label="Tags, separated by commas"
        className="tag-editor__input"
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            void save();
          }
        }}
        placeholder="clock, weather, e-ink"
        value={value}
      />
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

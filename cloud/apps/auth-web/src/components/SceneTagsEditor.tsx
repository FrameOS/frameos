"use client";

import { Check, Pencil, X } from "lucide-react";
import { useState } from "react";

const tagPattern = /^[a-z0-9][a-z0-9-]{0,23}$/;
const maxTags = 5;

// Owner editing of a scene's tags in the workspace's draft: comma/space
// separated slugs. The edit lands in the draft, not on the server — Save
// publishes it with the rest of the version (the server validates and
// moderates it then).
export function SceneTagsEditor({
  tags,
  onChange,
}: {
  tags: string[];
  onChange: (tags: string[]) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(tags.join(", "));
  const [error, setError] = useState<string | null>(null);

  function commit() {
    const nextTags = [
      ...new Set(
        value
          .split(/[\s,]+/)
          .map((tag) => tag.trim().toLowerCase())
          .filter(Boolean),
      ),
    ];
    if (nextTags.length > maxTags || nextTags.some((tag) => !tagPattern.test(tag))) {
      setError("Up to 5 tags; lowercase letters, digits, dashes, max 24 characters each.");
      return;
    }
    setError(null);
    setEditing(false);
    onChange(nextTags);
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
        autoFocus
        className="tag-editor__input"
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            commit();
          } else if (event.key === "Escape") {
            setEditing(false);
            setError(null);
          }
        }}
        placeholder="clock, weather, e-ink"
        value={value}
      />
      <button className="button" onClick={commit} type="button">
        <Check aria-hidden size={14} />
        Done
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

"use client";

import { Check, Pencil, X } from "lucide-react";
import { useState } from "react";
import { storeCategories } from "../lib/categories";

// Owner editing of a scene's category in the workspace's draft: one slug
// from the fixed store taxonomy (or none). New publishes are categorized
// automatically; this is the manual override, published by Save.
export function SceneCategoryEditor({
  category,
  onChange,
}: {
  category: string | null;
  onChange: (category: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(category ?? "");

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
        autoFocus
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
        onClick={() => {
          setEditing(false);
          onChange(value || null);
        }}
        type="button"
      >
        <Check aria-hidden size={14} />
        Done
      </button>
      <button className="button button--subtle" onClick={() => setEditing(false)} type="button">
        <X aria-hidden size={14} />
      </button>
    </span>
  );
}

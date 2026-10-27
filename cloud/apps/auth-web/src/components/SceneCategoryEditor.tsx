"use client";

import { Check, Pencil, X } from "lucide-react";
import { useState } from "react";
import { getStoreCategory, storeCategories } from "../lib/categories";

// Owner editing of a scene's category in the workspace's draft: one slug
// from the fixed store taxonomy (or none). New publishes are categorized
// automatically; this is the manual override, published by Save. The
// category's own pill is the button that opens it (visitors get a link into
// the store instead): beside an "Edit category" button, a click on the pill
// left the page for the store.
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
    const open = () => {
      setValue(category ?? "");
      setEditing(true);
    };
    if (category === null) {
      return (
        <button className="tag-edit-button" onClick={open} title="Set category" type="button">
          <Pencil aria-hidden size={14} />
          Set category
        </button>
      );
    }
    const title = getStoreCategory(category)?.title ?? category;
    return (
      <button
        aria-label={`Edit category: ${title}`}
        className="tag-pill tag-pill--category tag-pill--editable"
        onClick={open}
        title="Edit category"
        type="button"
      >
        {title}
        <Pencil aria-hidden size={12} />
      </button>
    );
  }

  return (
    <span className="tag-editor">
      <select
        aria-label="Category"
        autoFocus
        className="tag-editor__select"
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
        className="button button--small"
        onClick={() => {
          setEditing(false);
          onChange(value || null);
        }}
        type="button"
      >
        <Check aria-hidden size={14} />
        Done
      </button>
      <button
        aria-label="Cancel"
        className="button button--small button--subtle"
        onClick={() => setEditing(false)}
        type="button"
      >
        <X aria-hidden size={14} />
      </button>
    </span>
  );
}
